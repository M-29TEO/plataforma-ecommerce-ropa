import { ReturnDetailView } from '@/components/account/ReturnDetailView';

export default async function Page({ params }: PageProps<'/mi-cuenta/devoluciones/[id]'>) {
  return <ReturnDetailView returnId={(await params).id} />;
}
