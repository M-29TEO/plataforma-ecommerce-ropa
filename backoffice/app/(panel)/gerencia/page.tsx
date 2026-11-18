'use client';

import Link from 'next/link';
import { useState } from 'react';
import { DeliveryBlock } from '@/components/gerencia/DeliveryBlock';
import { FunnelBlock } from '@/components/gerencia/FunnelBlock';
import { KpiTiles } from '@/components/gerencia/KpiTiles';
import { initialRange, RangePicker, type RangeValue } from '@/components/gerencia/RangePicker';
import { SalesTrend } from '@/components/gerencia/SalesTrend';
import { TopItems } from '@/components/gerencia/TopItems';
import { useKpis } from '@/components/gerencia/useReports';
import { useCan } from '@/components/providers/AuthProvider';
import { PageHeader } from '@/components/ui/PageHeader';
import { formatDate } from '@/lib/format';

/**
 * Dashboard del gerente. Lee las vistas materializadas de /reports (refrescadas cada 15 min). Cada
 * bloque aparece solo con el permiso de su reporte y carga por su cuenta: si uno falla, los demás
 * siguen.
 */
export default function ManagementDashboardPage() {
  const can = useCan();
  const [value, setValue] = useState<RangeValue>(initialRange);
  const { range } = value;
  const kpis = useKpis(range, can);

  const canSales = can('reports.sales.read');
  const canFunnel = can('reports.funnel.read');
  const canDelivery = can('reports.delivery.read');

  return (
    <div>
      <PageHeader
        title="Dashboard de KPIs"
        description={`Del ${formatDate(`${range.from}T12:00:00Z`)} al ${formatDate(`${range.to}T12:00:00Z`)} · hora de Ecuador`}
        actions={
          can('reports.export') && (
            <Link href="/gerencia/exportes" className="btn-ghost btn-sm">
              Exportar a Excel / PDF
            </Link>
          )
        }
      />

      <div className="mb-4">
        <RangePicker value={value} onChange={setValue} />
      </div>

      <KpiTiles sales={kpis.sales} funnel={kpis.funnel} delivery={kpis.delivery} previous={kpis.previous} />

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {canSales && <SalesTrend range={range} />}
        {canSales && <TopItems range={range} />}
        {canFunnel && <FunnelBlock range={range} />}
        {canDelivery && <DeliveryBlock range={range} />}
      </div>
    </div>
  );
}
