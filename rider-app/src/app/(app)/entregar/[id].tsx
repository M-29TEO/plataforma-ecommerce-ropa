import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SignaturePad, SignaturePadRef } from '@/components/SignaturePad';
import { Banner, Button, Card, colors, Field, Muted, Row, styles as ui, Title } from '@/components/ui';
import { api } from '@/lib/api';
import { ApiError, errorMessage } from '@/lib/api-client';
import { changeDue, deliveryErrorMessage, DraftErrors, validateDraft } from '@/lib/delivery';
import { formatDistance, formatMoney, isPositiveAmount } from '@/lib/format';
import { haversineMeters, MAX_DELIVERY_DISTANCE_M } from '@/lib/geo';
import { useGpsStatus, useResource } from '@/lib/hooks';
import { currentPoint } from '@/lib/location-task';
import { useSession } from '@/lib/session';
import type { CodMethod } from '@/lib/types';

const COD_METHODS: Array<{ value: CodMethod; label: string }> = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'card_pos', label: 'Tarjeta (POS)' },
  { value: 'deuna_qr', label: 'DeUna (QR)' },
];

/** Foto comprimida (1280 px, JPEG 70 %): la API acepta hasta 5 MB y en la calle la señal es mala. */
async function takePhoto(): Promise<string | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    Alert.alert('Cámara', 'Permite el uso de la cámara para la foto de entrega.');
    return null;
  }
  const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8, exif: false });
  if (shot.canceled || !shot.assets[0]) return null;
  const asset = shot.assets[0];
  const ctx = ImageManipulator.manipulate(asset.uri);
  if ((asset.width ?? 0) > 1280) ctx.resize({ width: 1280 });
  const image = await ctx.renderAsync();
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
  return saved.uri;
}

/** Prueba de entrega: foto, firma en pantalla, código OTP del cliente y cobro contra entrega. */
export default function DeliverScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const shipment = useResource(() => api.shipment(id), { key: id });
  const session = useSession();
  const gps = useGpsStatus();
  const signature = useRef<SignaturePadRef>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [signatureComplete, setSignatureComplete] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [receiverName, setReceiverName] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [codMethod, setCodMethod] = useState<CodMethod>('cash');
  const [codConfirmed, setCodConfirmed] = useState(false);
  const [received, setReceived] = useState('');
  const [errors, setErrors] = useState<DraftErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onSignatureChange = useCallback((complete: boolean) => setSignatureComplete(complete), []);

  const s = shipment.data;
  if (!s) {
    return (
      <View style={[ui.screen, ui.content]}>
        <Banner text={shipment.error} />
        {!shipment.error ? <Muted>Cargando…</Muted> : null}
      </View>
    );
  }

  const name = receiverName ?? (typeof s.destination.recipientName === 'string' ? s.destination.recipientName : '');
  const hasCod = isPositiveAmount(s.codAmount);
  const me = gps.lastFix ? { lat: gps.lastFix.lat, lng: gps.lastFix.lng } : null;
  const distance = me && s.destination.location ? Math.round(haversineMeters(me, s.destination.location)) : null;
  const change = hasCod && codMethod === 'cash' && received ? changeDue(s.codAmount, received) : null;

  const pickPhoto = async () => {
    try {
      const uri = await takePhoto();
      if (uri) setPhotoUri(uri);
    } catch (e) {
      Alert.alert('Foto', errorMessage(e));
    }
  };

  const submit = async () => {
    const draft = { photoUri, signatureComplete, receiverName: name, otp, requiresOtp: s.requiresOtp, codAmount: s.codAmount, codMethod, codConfirmed };
    const found = validateDraft(draft);
    setErrors(found);
    setSubmitError(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const signatureUri = await signature.current?.capture();
      if (!signatureUri) {
        setErrors({ signature: 'Falta la firma de quien recibe' });
        return;
      }
      const at = await currentPoint(15_000);
      if (!at) {
        setSubmitError('No se pudo obtener tu ubicación: revisa que el GPS esté activo.');
        return;
      }
      await api.deliver(s.id, {
        at,
        receiverName: name.trim(),
        otp: s.requiresOtp ? otp.trim() : undefined,
        codCollected: hasCod ? s.codAmount : undefined,
        codMethod: hasCod ? codMethod : undefined,
        photo: { uri: photoUri!, name: 'entrega.jpg', type: 'image/jpeg' },
        signature: { uri: signatureUri, name: 'firma.png', type: 'image/png' },
      });
      void session.refreshProfile();
      Alert.alert('¡Entregado!', hasCod ? `Cobraste ${formatMoney(s.codAmount)}.` : 'Gracias por tu entrega.', [{ text: 'Listo', onPress: () => router.dismissAll() }]);
    } catch (e) {
      setSubmitError(e instanceof ApiError ? deliveryErrorMessage(e) : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView style={ui.screen} contentContainerStyle={ui.content} scrollEnabled={!drawing} keyboardShouldPersistTaps="handled">
        <Card>
          <Title>{s.orderNumber ? `Pedido ${s.orderNumber}` : 'Entrega'}</Title>
          <Muted>{s.destination.label}</Muted>
          {distance !== null && distance > MAX_DELIVERY_DISTANCE_M ? (
            <Banner text={`Estás a ${formatDistance(distance)} del destino: acércate a menos de ${MAX_DELIVERY_DISTANCE_M} m para entregar.`} tone="warning" />
          ) : null}
        </Card>

        <Card>
          <Title>1. Foto de la entrega</Title>
          {photoUri ? <Image source={{ uri: photoUri }} style={styles.photo} accessibilityLabel="Foto de la entrega" /> : null}
          <Button title={photoUri ? 'Tomar otra foto' : 'Tomar foto'} variant="secondary" onPress={() => void pickPhoto()} />
          {errors.photo ? <Text style={styles.error}>{errors.photo}</Text> : null}
        </Card>

        <Card>
          <Title>2. Quién recibe</Title>
          <Field label="Nombre" value={name} onChangeText={setReceiverName} autoCapitalize="words" error={errors.receiverName} />
          {s.requiresOtp ? (
            <Field
              label="Código de entrega (lo ve el cliente en su seguimiento)"
              value={otp}
              onChangeText={(t) => setOtp(t.replace(/\D/g, '').slice(0, 4))}
              keyboardType="number-pad"
              maxLength={4}
              style={styles.otp}
              error={errors.otp}
            />
          ) : null}
        </Card>

        {hasCod ? (
          <Card>
            <Title>3. Cobro contra entrega</Title>
            <Row label="Monto a cobrar" value={formatMoney(s.codAmount)} strong />
            <View style={styles.methods}>
              {COD_METHODS.map((m) => (
                <Pressable
                  key={m.value}
                  onPress={() => setCodMethod(m.value)}
                  style={[styles.method, codMethod === m.value && styles.methodActive]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: codMethod === m.value }}
                >
                  <Text style={[styles.methodText, codMethod === m.value && { color: '#FFFFFF' }]}>{m.label}</Text>
                </Pressable>
              ))}
            </View>
            {codMethod === 'cash' ? (
              <>
                <Field label="¿Con cuánto paga? (para el vuelto)" value={received} onChangeText={setReceived} keyboardType="decimal-pad" placeholder={s.codAmount} />
                {received ? <Row label="Vuelto" value={change !== null ? formatMoney(change) : 'No alcanza'} strong /> : null}
              </>
            ) : null}
            <View style={styles.confirm}>
              <Text style={{ flex: 1, fontSize: 16, color: colors.text }}>Cobré {formatMoney(s.codAmount)}</Text>
              <Switch value={codConfirmed} onValueChange={setCodConfirmed} accessibilityLabel="Confirmo el cobro" />
            </View>
            {errors.cod ? <Text style={styles.error}>{errors.cod}</Text> : null}
          </Card>
        ) : null}

        <Card>
          <Title>{hasCod ? '4.' : '3.'} Firma de quien recibe</Title>
          <SignaturePad ref={signature} onChange={onSignatureChange} onDrawingChange={setDrawing} />
          {errors.signature ? <Text style={styles.error}>{errors.signature}</Text> : null}
        </Card>

        <Banner text={submitError} />
        <Button title="Confirmar entrega" variant="success" onPress={() => void submit()} loading={busy} testID="confirm-delivery" />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  photo: { width: '100%', height: 220, borderRadius: 12, backgroundColor: colors.border },
  error: { color: colors.danger, fontSize: 14 },
  otp: { fontSize: 28, letterSpacing: 12, textAlign: 'center', fontWeight: '700' },
  methods: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  method: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 10 },
  methodActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  methodText: { fontSize: 15, color: colors.text, fontWeight: '600' },
  confirm: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
});
