import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from './ui';

/**
 * Lista de opciones en una hoja inferior. Reemplaza a Alert.alert para elegir un motivo: en
 * Android un Alert muestra como mucho 3 botones.
 */
export function ChoiceSheet({
  visible,
  title,
  message,
  options,
  onChoose,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message?: string;
  options: readonly string[];
  onChoose: (option: string) => void;
  onCancel: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel} accessibilityLabel="Cerrar" />
      <View style={styles.sheet}>
        <Text style={styles.title}>{title}</Text>
        {message ? <Text style={styles.message}>{message}</Text> : null}
        {options.map((o) => (
          <Pressable key={o} style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.bg }]} onPress={() => onChoose(o)} accessibilityRole="button">
            <Text style={styles.optionText}>{o}</Text>
          </Pressable>
        ))}
        <Pressable style={styles.cancel} onPress={onCancel} accessibilityRole="button">
          <Text style={[styles.optionText, { color: colors.muted }]}>Cancelar</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 16, paddingBottom: 28, gap: 4 },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  message: { fontSize: 14, color: colors.muted, marginBottom: 8 },
  option: { minHeight: 52, justifyContent: 'center', paddingHorizontal: 8, borderBottomWidth: 1, borderColor: colors.border },
  optionText: { fontSize: 17, color: colors.text },
  cancel: { minHeight: 52, justifyContent: 'center', paddingHorizontal: 8 },
});
