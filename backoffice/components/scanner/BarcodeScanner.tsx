'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  BARCODE_FORMATS,
  cameraErrorMessage,
  cameraSupport,
  createDebouncer,
  DEBOUNCE_MS,
  INSECURE_CONTEXT_MESSAGE,
  normalizeBarcode,
} from '@/lib/scanner';

/** Tipos mínimos del BarcodeDetector nativo (Chrome/Edge en Android, ChromeOS, macOS). */
interface DetectedBarcode {
  rawValue: string;
}
interface NativeBarcodeDetector {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}
interface NativeBarcodeDetectorCtor {
  new (opts: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats(): Promise<string[]>;
}

type Engine = 'native' | 'zxing';

/**
 * Escáner de códigos de barras reutilizable.
 *
 * - Cámara trasera (getUserMedia, facingMode environment) que se abre al pulsar "Usar cámara".
 *   Decodifica con BarcodeDetector nativo si existe y, si no, con @zxing/browser (import dinámico).
 * - Siempre ofrece entrada manual: escribir el código + Enter. Los lectores USB/Bluetooth "teclean"
 *   el código y mandan Enter, así que funcionan sobre ese mismo campo (queda enfocado).
 * - Antirrebote de la cámara: el mismo código dentro de 1,5 s cuenta una vez (la cámara lee el mismo
 *   código decenas de veces por segundo). Lo que entra por teclado/lector no se filtra: cada Enter es
 *   una lectura intencional (dos prendas iguales seguidas).
 * - Vibración corta y pitido opcional al leer. Libera la cámara al desmontar o al ocultar la pestaña.
 */
export function BarcodeScanner({
  onDetected,
  active = true,
  sound = true,
  label = 'Código de barras',
  placeholder = 'Escanea o escribe el código y pulsa Enter',
  autoFocus = true,
  busy = false,
}: {
  onDetected: (code: string) => void;
  /** false = en pausa: no se aceptan lecturas (la cámara queda abierta). */
  active?: boolean;
  /** Pitido al leer (el usuario puede apagarlo). */
  sound?: boolean;
  label?: string;
  placeholder?: string;
  autoFocus?: boolean;
  /** Muestra que la lectura anterior se está procesando. */
  busy?: boolean;
}) {
  const inputId = useId();
  const videoRef = useRef<HTMLVideoElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onDetectedRef = useRef(onDetected);
  const activeRef = useRef(active);
  const soundRef = useRef(sound);
  const audioRef = useRef<AudioContext | null>(null);
  const debounceRef = useRef(createDebouncer(DEBOUNCE_MS));

  const [cameraOn, setCameraOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [engine, setEngine] = useState<Engine | null>(null);
  const [cameraError, setCameraError] = useState('');
  const [soundOn, setSoundOn] = useState(sound);
  const [manual, setManual] = useState('');
  const [lastRead, setLastRead] = useState<string | null>(null);

  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    soundRef.current = soundOn;
  }, [soundOn]);

  // Al ocultar la pestaña se apaga la cámara (en el móvil queda encendida si no).
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') setCameraOn(false);
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  useEffect(
    () => () => {
      void audioRef.current?.close().catch(() => undefined);
    },
    [],
  );

  function feedback() {
    try {
      navigator.vibrate?.(60);
    } catch {
      // Sin vibración (escritorio, iOS).
    }
    const ctx = audioRef.current;
    if (!soundRef.current || !ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = 1760;
      gain.gain.value = 0.06;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.08);
    } catch {
      // Audio no disponible.
    }
  }

  function emit(raw: string, fromCamera: boolean) {
    const code = normalizeBarcode(raw);
    if (!code || !activeRef.current) return;
    if (fromCamera && !debounceRef.current(code)) return;
    feedback();
    setLastRead(code);
    onDetectedRef.current(code);
  }
  // emit se usa desde el bucle de la cámara: se guarda en un ref para leer siempre la última versión.
  const emitRef = useRef(emit);
  useEffect(() => {
    emitRef.current = emit;
  });

  // Ciclo de vida de la cámara: abre el stream, arranca el decodificador y lo libera todo al apagar o desmontar.
  useEffect(() => {
    if (!cameraOn) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopDecoder: (() => void) | null = null;
    const video = videoRef.current;

    const release = () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      try {
        stopDecoder?.();
      } catch {
        // El decodificador ya estaba detenido.
      }
      stream?.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled || !video) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        video.srcObject = stream;
        video.setAttribute('playsinline', 'true');
        await video.play().catch(() => undefined);
        if (cancelled) return;

        const Native = (globalThis as unknown as { BarcodeDetector?: NativeBarcodeDetectorCtor }).BarcodeDetector;
        let formats: string[] = [];
        if (Native) {
          const supported = await Native.getSupportedFormats().catch(() => [] as string[]);
          formats = BARCODE_FORMATS.filter((f) => supported.includes(f));
        }

        if (Native && formats.length > 0) {
          const detector = new Native({ formats });
          setEngine('native');
          const tick = async () => {
            if (cancelled) return;
            if (activeRef.current && video.readyState >= 2) {
              try {
                const found = await detector.detect(video);
                if (found[0]?.rawValue) emitRef.current(found[0].rawValue, true);
              } catch {
                // Cuadro no decodificable: se reintenta en el siguiente.
              }
            }
            if (!cancelled) timer = setTimeout(tick, 120);
          };
          void tick();
        } else {
          const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
            import('@zxing/browser'),
            import('@zxing/library'),
          ]);
          if (cancelled) return;
          const hints = new Map<number, unknown>([
            [
              DecodeHintType.POSSIBLE_FORMATS,
              [
                BarcodeFormat.EAN_13,
                BarcodeFormat.EAN_8,
                BarcodeFormat.UPC_A,
                BarcodeFormat.UPC_E,
                BarcodeFormat.CODE_128,
                BarcodeFormat.CODE_39,
                BarcodeFormat.QR_CODE,
              ],
            ],
          ]);
          const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 150 });
          const controls = await reader.decodeFromVideoElement(video, (result) => {
            if (result && activeRef.current) emitRef.current(result.getText(), true);
          });
          if (cancelled) {
            controls.stop();
            return;
          }
          stopDecoder = () => controls.stop();
          setEngine('zxing');
        }
        setStarting(false);
      } catch (e) {
        if (cancelled) return;
        release();
        setCameraError(cameraErrorMessage((e as { name?: string } | null)?.name));
        setStarting(false);
        setCameraOn(false);
      }
    })();

    return release;
  }, [cameraOn]);

  function toggleCamera() {
    if (cameraOn) {
      setCameraOn(false);
      setEngine(null);
      return;
    }
    setCameraError('');
    const support = cameraSupport({
      isSecureContext: window.isSecureContext,
      hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
    });
    if (support === 'insecure') {
      setCameraError(INSECURE_CONTEXT_MESSAGE);
      return;
    }
    if (support === 'unsupported') {
      setCameraError('Este navegador no permite usar la cámara. Usa la entrada manual o un lector.');
      return;
    }
    // El AudioContext se crea dentro del gesto del usuario (si no, el navegador lo deja mudo).
    if (!audioRef.current) {
      try {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) audioRef.current = new Ctx();
      } catch {
        audioRef.current = null;
      }
    }
    setStarting(true);
    setCameraOn(true);
  }

  function submitManual(e: React.FormEvent) {
    e.preventDefault();
    if (!audioRef.current) {
      try {
        audioRef.current = new AudioContext();
      } catch {
        audioRef.current = null;
      }
    }
    emit(manual, false);
    setManual('');
    inputRef.current?.focus();
  }

  return (
    <div className="space-y-3">
      <form onSubmit={submitManual} className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <label htmlFor={inputId} className="label">
            {label}
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className="input font-mono"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder={placeholder}
            autoFocus={autoFocus}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="done"
            inputMode="text"
            maxLength={64}
            readOnly={!active}
            aria-disabled={!active}
          />
        </div>
        <button type="submit" className="btn-primary" disabled={!active || !manual.trim()}>
          Agregar
        </button>
        <button type="button" className={cameraOn ? 'btn-danger' : 'btn-ghost'} onClick={toggleCamera} aria-pressed={cameraOn}>
          {cameraOn ? 'Apagar cámara' : 'Usar cámara'}
        </button>
      </form>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
        <label className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={soundOn} onChange={(e) => setSoundOn(e.target.checked)} />
          Sonido al leer
        </label>
        {!active && <span className="font-medium text-warn">Escáner en pausa</span>}
        {busy && <span>Procesando…</span>}
        {lastRead && (
          <span>
            Última lectura: <span className="font-mono text-ink">{lastRead}</span>
          </span>
        )}
      </div>

      {cameraError && (
        <p className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn" role="alert">
          {cameraError}
        </p>
      )}

      {cameraOn && (
        <div className="relative mx-auto aspect-[4/3] w-full max-w-md overflow-hidden rounded-lg bg-ink">
          <video ref={videoRef} className="h-full w-full object-cover" muted playsInline aria-label="Vista de la cámara" />
          {/* Guía de encuadre */}
          <div className="pointer-events-none absolute inset-x-[10%] top-1/2 h-1/3 -translate-y-1/2 rounded-md border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.25)]" />
          <div className="pointer-events-none absolute inset-x-[12%] top-1/2 h-0.5 -translate-y-1/2 bg-danger/80" />
          <p className="absolute right-0 bottom-0 left-0 bg-ink/60 px-3 py-1.5 text-center text-xs text-paper">
            {starting
              ? 'Abriendo cámara…'
              : !active
                ? 'En pausa'
                : `Apunta al código${engine === 'zxing' ? ' (lector compatible)' : ''}`}
          </p>
        </div>
      )}
    </div>
  );
}
