import { Redirect } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner, Button, colors, Field, Muted } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api-client';
import { useSession } from '@/lib/session';

function loginError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'INVALID_CREDENTIALS') return 'Correo o contraseña incorrectos';
    if (e.code === 'ACCOUNT_LOCKED') return 'Cuenta bloqueada por intentos fallidos. Espera unos minutos o pide ayuda a logística.';
    if (e.code === 'INVALID_MFA_CODE') return 'Código incorrecto';
    if (e.status === 429) return 'Demasiados intentos: espera un momento';
  }
  return e instanceof Error && !(e instanceof ApiError) && e.message ? e.message : errorMessage(e);
}

export default function LoginScreen() {
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.status === 'signed-in') return <Redirect href="/" />;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) await session.loginMfa(mfaToken, code.trim());
      else {
        const pending = await session.login(email, password);
        if (pending) setMfaToken(pending);
      }
    } catch (e) {
      setError(loginError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.logo}>Moda</Text>
            <Text style={styles.subtitle}>App del motorizado</Text>
          </View>
          <Banner text={error} />
          {mfaToken ? (
            <>
              <Muted>Ingresa el código de 6 dígitos de tu app de autenticación.</Muted>
              <Field label="Código" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} autoFocus textContentType="oneTimeCode" />
              <Button title="Verificar" onPress={submit} loading={busy} disabled={code.trim().length !== 6} />
              <Button title="Volver" variant="secondary" onPress={() => (setMfaToken(null), setCode(''))} />
            </>
          ) : (
            <>
              <Field label="Correo" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" />
              <Field label="Contraseña" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" textContentType="password" onSubmitEditing={submit} />
              <Button title="Iniciar sesión" onPress={submit} loading={busy} disabled={!email.trim() || !password} testID="login-submit" />
            </>
          )}
          <Muted style={{ textAlign: 'center', marginTop: 12 }}>¿Olvidaste tu contraseña? Pídele a logística que la restablezca.</Muted>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 12, flexGrow: 1, justifyContent: 'center' },
  brand: { alignItems: 'center', marginBottom: 24 },
  logo: { fontSize: 40, fontWeight: '900', color: colors.text, letterSpacing: 1 },
  subtitle: { fontSize: 16, color: colors.muted },
});
