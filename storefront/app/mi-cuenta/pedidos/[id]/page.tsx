import { OrderDetailView } from '@/components/account/OrderDetailView';

export default async function Page({ params }: PageProps<'/mi-cuenta/pedidos/[id]'>) {
  return <OrderDetailView orderId={(await params).id} />;
}
