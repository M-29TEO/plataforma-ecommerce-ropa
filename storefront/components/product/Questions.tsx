'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api/client';
import type { Question } from '@/lib/commerce-types';
import { formatDate } from '@/lib/format';
import { useAuth } from '../providers/AuthProvider';
import { useToast } from '../providers/ToastProvider';

export function Questions({ productId }: { productId: string }) {
  const { status } = useAuth();
  const pathname = usePathname();
  const toast = useToast();
  const [list, setList] = useState<Question[] | null>(null);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    void api<Question[]>(`/products/${productId}/questions?limit=10`)
      .then(setList)
      .catch(() => setList([]));
  }, [productId]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    try {
      await api(`/products/${productId}/questions`, { method: 'POST', body: { body: body.trim() } });
      setBody('');
      setSent(true);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <section aria-labelledby="qa-title" className="mt-14 border-t border-line pt-10">
      <h2 id="qa-title" className="text-2xl">
        Preguntas y respuestas
      </h2>
      {list && list.length === 0 && <p className="mt-3 text-sm text-ink-soft">Nadie ha preguntado todavía.</p>}
      <ul className="mt-4 space-y-5">
        {list?.map((q) => (
          <li key={q.id}>
            <p className="text-sm font-medium">P: {q.body}</p>
            {q.answers.map((a) => (
              <p key={a.id} className="mt-1 border-l-2 border-line pl-3 text-sm text-ink-soft">
                <span className={a.isOfficial ? 'font-semibold text-ink' : ''}>{a.author}</span>: {a.body}{' '}
                <span className="text-xs">· {formatDate(a.createdAt)}</span>
              </p>
            ))}
          </li>
        ))}
      </ul>
      {status === 'authenticated' ? (
        sent ? (
          <p className="mt-6 text-sm text-ok">Recibimos tu pregunta. Te avisaremos cuando la respondamos.</p>
        ) : (
          <form onSubmit={ask} className="mt-6 flex max-w-2xl flex-col gap-2 sm:flex-row">
            <label htmlFor="question" className="sr-only">
              Tu pregunta
            </label>
            <input id="question" className="input" placeholder="¿Tienes una duda sobre este producto?" minLength={10} maxLength={500} required value={body} onChange={(e) => setBody(e.target.value)} />
            <button className="btn-ghost" disabled={sending || body.trim().length < 10}>
              Preguntar
            </button>
          </form>
        )
      ) : (
        <p className="mt-6 text-sm text-ink-soft">
          <Link href={`/ingresar?volver=${encodeURIComponent(pathname)}`} className="underline">
            Inicia sesión
          </Link>{' '}
          para hacer una pregunta.
        </p>
      )}
    </section>
  );
}
