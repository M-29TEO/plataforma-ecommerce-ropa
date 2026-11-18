import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleProp, StyleSheet, Text, TextInput, TextInputProps, View, ViewStyle } from 'react-native';

/** Paleta y piezas comunes. Botones grandes (≥ 52 px): se usan con guantes y en movimiento. */
export const colors = {
  bg: '#F3F4F6',
  card: '#FFFFFF',
  text: '#111827',
  muted: '#6B7280',
  border: '#E5E7EB',
  primary: '#111827',
  primaryText: '#FFFFFF',
  accent: '#2563EB',
  success: '#047857',
  successBg: '#D1FAE5',
  warning: '#B45309',
  warningBg: '#FEF3C7',
  danger: '#B91C1C',
  dangerBg: '#FEE2E2',
};

type Variant = 'primary' | 'secondary' | 'danger' | 'success';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
  style,
  testID,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const v = VARIANTS[variant];
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [styles.button, { backgroundColor: v.bg, borderColor: v.border }, (disabled || loading) && styles.disabled, pressed && styles.pressed, style]}
    >
      {loading ? <ActivityIndicator color={v.fg} /> : <Text style={[styles.buttonText, { color: v.fg }]}>{title}</Text>}
    </Pressable>
  );
}

const VARIANTS: Record<Variant, { bg: string; fg: string; border: string }> = {
  primary: { bg: colors.primary, fg: colors.primaryText, border: colors.primary },
  secondary: { bg: colors.card, fg: colors.text, border: colors.border },
  danger: { bg: colors.dangerBg, fg: colors.danger, border: colors.dangerBg },
  success: { bg: colors.success, fg: '#FFFFFF', border: colors.success },
};

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={styles.title}>{children}</Text>;
}

export function Muted({ children, style }: { children: ReactNode; style?: object }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function Row({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.strong]}>{value}</Text>
    </View>
  );
}

export function Badge({ text, tone = 'neutral' }: { text: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }) {
  const t = { neutral: [colors.border, colors.text], success: [colors.successBg, colors.success], warning: [colors.warningBg, colors.warning], danger: [colors.dangerBg, colors.danger] }[tone];
  return (
    <View style={[styles.badge, { backgroundColor: t[0] }]}>
      <Text style={[styles.badgeText, { color: t[1] }]}>{text}</Text>
    </View>
  );
}

export function Banner({ text, tone = 'danger' }: { text: string | null | undefined; tone?: 'danger' | 'warning' | 'success' }) {
  if (!text) return null;
  const t = { danger: [colors.dangerBg, colors.danger], warning: [colors.warningBg, colors.warning], success: [colors.successBg, colors.success] }[tone];
  return (
    <View accessibilityRole="alert" style={[styles.banner, { backgroundColor: t[0] }]}>
      <Text style={{ color: t[1], fontSize: 15 }}>{text}</Text>
    </View>
  );
}

export function Field({ label, error, ...props }: TextInputProps & { label: string; error?: string | null }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} {...props} style={[styles.input, error ? { borderColor: colors.danger } : null, props.style]} />
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 12, paddingBottom: 32 },
  button: { minHeight: 52, borderRadius: 12, borderWidth: 1, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 17, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
  card: { backgroundColor: colors.card, borderRadius: 14, padding: 16, gap: 8, borderWidth: 1, borderColor: colors.border },
  title: { fontSize: 18, fontWeight: '700', color: colors.text },
  muted: { fontSize: 14, color: colors.muted },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  rowLabel: { fontSize: 15, color: colors.muted, flexShrink: 1 },
  rowValue: { fontSize: 15, color: colors.text, textAlign: 'right', flexShrink: 1 },
  strong: { fontWeight: '700', fontSize: 17 },
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 13, fontWeight: '600' },
  banner: { borderRadius: 10, padding: 12 },
  label: { fontSize: 14, color: colors.muted, marginBottom: 6 },
  input: { minHeight: 52, borderWidth: 1, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 14, fontSize: 17, backgroundColor: colors.card, color: colors.text },
  fieldError: { color: colors.danger, marginTop: 4, fontSize: 13 },
});
