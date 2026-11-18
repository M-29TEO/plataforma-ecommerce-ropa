import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import { isSignatureComplete, Stroke, strokeToPath } from '@/lib/signature';
import { colors } from './ui';

export interface SignaturePadRef {
  /** PNG temporal de la firma (file://...) o null si no hay firma suficiente. */
  capture(): Promise<string | null>;
  clear(): void;
}

/**
 * Firma en pantalla: los trazos se dibujan con react-native-svg y se exportan a PNG con
 * react-native-view-shot (fondo blanco, sin transparencia). `onDrawingChange` deja bloquear el
 * scroll de la pantalla mientras se firma.
 */
export const SignaturePad = forwardRef<SignaturePadRef, { onChange?: (complete: boolean) => void; onDrawingChange?: (drawing: boolean) => void }>(
  function SignaturePad({ onChange, onDrawingChange }, ref) {
    const [strokes, setStrokes] = useState<Stroke[]>([]);
    const strokesRef = useRef<Stroke[]>([]);
    const current = useRef<Stroke | null>(null);
    const canvas = useRef<View>(null);
    const [, force] = useState(0);

    const commit = (next: Stroke[]) => {
      strokesRef.current = next;
      setStrokes(next);
      onChange?.(isSignatureComplete(next));
    };

    const responder = useMemo(
      () =>
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: () => true,
          onPanResponderTerminationRequest: () => false,
          onPanResponderGrant: (e) => {
            onDrawingChange?.(true);
            current.current = [{ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY }];
            force((n) => n + 1);
          },
          onPanResponderMove: (e) => {
            current.current?.push({ x: e.nativeEvent.locationX, y: e.nativeEvent.locationY });
            force((n) => n + 1);
          },
          onPanResponderRelease: () => {
            onDrawingChange?.(false);
            const done = current.current;
            current.current = null;
            if (done) commit([...strokesRef.current, done]);
          },
          onPanResponderTerminate: () => {
            onDrawingChange?.(false);
            current.current = null;
          },
        }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [onChange, onDrawingChange],
    );

    useImperativeHandle(ref, () => ({
      async capture() {
        if (!isSignatureComplete(strokes)) return null;
        return captureRef(canvas, { format: 'png', quality: 1, result: 'tmpfile' });
      },
      clear() {
        commit([]);
      },
    }));

    const all = current.current ? [...strokes, current.current] : strokes;
    return (
      <View>
        <View ref={canvas} collapsable={false} style={styles.canvas} {...responder.panHandlers} accessibilityLabel="Área de firma">
          <Svg width="100%" height="100%">
            <Rect x={0} y={0} width="100%" height="100%" fill="#FFFFFF" />
            {all.map((s, i) => (
              <Path key={i} d={strokeToPath(s)} stroke="#111827" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            ))}
          </Svg>
          {all.length === 0 ? (
            <Text pointerEvents="none" style={styles.hint}>
              Firma aquí
            </Text>
          ) : null}
        </View>
        <Pressable onPress={() => commit([])} style={styles.clear} accessibilityRole="button">
          <Text style={{ color: colors.accent, fontSize: 15 }}>Borrar firma</Text>
        </Pressable>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  canvas: { height: 200, borderRadius: 12, borderWidth: 1, borderColor: colors.border, overflow: 'hidden', backgroundColor: '#FFFFFF' },
  hint: { position: 'absolute', alignSelf: 'center', top: 88, color: colors.muted, fontSize: 16 },
  clear: { alignSelf: 'flex-end', paddingVertical: 8 },
});
