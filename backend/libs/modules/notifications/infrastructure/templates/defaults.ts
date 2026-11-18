import type { Channel } from '../../domain/channel';
import type { TemplateCode } from '../../domain/catalog';
import type { SupportedLocale } from '../../domain/locale';

/**
 * Plantillas Handlebars que trae el sistema, por idioma, código y canal. Un tenant puede
 * reemplazar cualquiera desde el backoffice (platform.notification_templates); estas son el respaldo.
 *
 * - email: `body` es HTML (Handlebars escapa las variables); el motor lo envuelve en el layout y
 *   genera la versión de texto. Parcial disponible: {{> items}} (líneas del pedido o del carrito).
 * - webpush / ntfy: `subject` es el título y `body` el texto.
 * - whatsapp / sms: solo `body` (texto plano; el SMS debe ser corto).
 *
 * Datos comunes: brand, storefrontUrl, name (puede faltar), locale. Helpers: money, fecha, eq.
 */
export interface DefaultTemplate {
  subject?: string;
  body: string;
}

export type DefaultTemplates = Record<SupportedLocale, Partial<Record<TemplateCode, Partial<Record<Channel, DefaultTemplate>>>>>;

const hola = '{{#if name}}Hola, {{name}}:{{else}}Hola:{{/if}}';
const hi = '{{#if name}}Hi {{name}},{{else}}Hi,{{/if}}';

export const DEFAULT_TEMPLATES: DefaultTemplates = {
  'es-EC': {
    'order.placed': {
      email: {
        subject: 'Recibimos tu pedido #{{orderNumber}}',
        body: `<p>${hola}</p>
<p>Gracias por comprar en {{brand}}. Recibimos tu pedido <strong>#{{orderNumber}}</strong>.</p>
{{> items}}
<p><strong>Total: {{money total}}</strong></p>
{{#if (eq paymentMethod "cod")}}<p>Pagas al recibir: ten listo el valor exacto o tu tarjeta.</p>{{/if}}
{{#if (eq paymentMethod "transfer")}}<p>Recuerda subir el comprobante de la transferencia para que preparemos tu pedido.</p>{{/if}}
<p><a href="{{orderUrl}}">Ver mi pedido</a></p>`,
      },
      webpush: { subject: 'Pedido #{{orderNumber}} recibido', body: 'Total {{money total}}. Te avisaremos cada paso.' },
      whatsapp: { body: '{{brand}}: recibimos tu pedido #{{orderNumber}} por {{money total}}. Síguelo aquí: {{orderUrl}}' },
    },
    'order.paid': {
      email: {
        subject: 'Pago confirmado del pedido #{{orderNumber}}',
        body: `<p>${hola}</p>
<p>Confirmamos el pago de <strong>{{money total}}</strong> de tu pedido <strong>#{{orderNumber}}</strong>. Ya lo estamos preparando.</p>
<p>Tu factura electrónica llegará en un correo aparte cuando el SRI la autorice.</p>
<p><a href="{{orderUrl}}">Ver mi pedido</a></p>`,
      },
      webpush: { subject: 'Pago confirmado', body: 'Pedido #{{orderNumber}}: ya lo estamos preparando.' },
    },
    'order.cancelled': {
      email: {
        subject: 'Tu pedido #{{orderNumber}} fue cancelado',
        body: `<p>${hola}</p>
<p>Tu pedido <strong>#{{orderNumber}}</strong> fue cancelado.{{#if reason}} Motivo: {{reason}}.{{/if}}</p>
{{#if (eq paymentStatus "paid")}}<p>Como ya estaba pagado, iniciamos el reembolso de {{money total}} al mismo medio de pago.</p>{{/if}}
<p>Si no reconoces esta cancelación, responde a este correo.</p>`,
      },
      webpush: { subject: 'Pedido #{{orderNumber}} cancelado', body: '{{#if reason}}{{reason}}{{else}}Toca para ver el detalle.{{/if}}' },
    },
    'order.delivered': {
      email: {
        subject: '¡Tu pedido #{{orderNumber}} fue entregado!',
        body: `<p>${hola}</p>
<p>Entregamos tu pedido <strong>#{{orderNumber}}</strong> el {{fecha deliveredAt}}. ¡Esperamos que lo disfrutes!</p>
<p>¿Algo no quedó bien? Tienes {{returnWindowDays}} días para pedir un cambio o una devolución desde <a href="{{orderUrl}}">tu pedido</a>.</p>`,
      },
      webpush: { subject: 'Pedido entregado', body: 'Tu pedido #{{orderNumber}} llegó. ¡Que lo disfrutes!' },
    },
    'shipment.assigned': {
      webpush: { subject: 'Tu pedido ya tiene repartidor', body: 'Pedido #{{orderNumber}}: {{#if (eq carrierType "courier")}}lo lleva el courier{{else}}un motorizado lo llevará{{/if}}.' },
    },
    'shipment.picked_up': {
      webpush: { subject: 'Tu pedido salió de bodega', body: 'Pedido #{{orderNumber}}. Síguelo en vivo.' },
    },
    'shipment.in_transit': {
      webpush: { subject: 'Tu pedido está en camino', body: 'Pedido #{{orderNumber}}. Toca para seguirlo.' },
      email: {
        subject: 'Tu pedido #{{orderNumber}} está en camino',
        body: `<p>${hola}</p>
<p>Tu pedido <strong>#{{orderNumber}}</strong> está en camino.</p>
<p><a href="{{trackingUrl}}">Seguir mi envío</a></p>`,
      },
    },
    'shipment.arriving': {
      webpush: { subject: '¡Ya casi llega!', body: 'El repartidor está cerca con tu pedido #{{orderNumber}}.' },
      sms: { body: '{{brand}}: tu pedido #{{orderNumber}} esta por llegar. Sigue tu envio: {{trackingUrl}}' },
    },
    'shipment.delivered': {
      webpush: { subject: 'Envío entregado', body: 'Entregamos el envío de tu pedido #{{orderNumber}}.' },
    },
    'shipment.failed_attempt': {
      webpush: { subject: 'No pudimos entregar tu pedido', body: 'Pedido #{{orderNumber}}: lo intentaremos de nuevo. Toca para ver el detalle.' },
      email: {
        subject: 'No pudimos entregar tu pedido #{{orderNumber}}',
        body: `<p>${hola}</p>
<p>Intentamos entregar tu pedido <strong>#{{orderNumber}}</strong> pero no fue posible.{{#if description}} Detalle: {{description}}.{{/if}}</p>
<p>Volveremos a intentarlo. Revisa el estado o coordina la entrega desde <a href="{{trackingUrl}}">el seguimiento</a>.</p>`,
      },
      sms: { body: '{{brand}}: no pudimos entregar tu pedido #{{orderNumber}}. Detalle: {{trackingUrl}}' },
    },
    'shipment.returned_to_origin': {
      email: {
        subject: 'Tu pedido #{{orderNumber}} volvió a nuestra bodega',
        body: `<p>${hola}</p>
<p>Después de varios intentos, el envío de tu pedido <strong>#{{orderNumber}}</strong> volvió a nuestra bodega. Te contactaremos para coordinar una nueva entrega o el reembolso.</p>`,
      },
    },
    'invoice.authorized': {
      webpush: { subject: 'Tu {{#if (eq docType "04")}}nota de crédito{{else}}factura{{/if}} está lista', body: '{{#if orderNumber}}Pedido #{{orderNumber}}: {{/if}}autorizada por el SRI. Te la enviamos por email.' },
    },
    'invoice.rejected': {
      ntfy: {
        subject: 'SRI: {{docLabel}} {{statusLabel}}',
        body: `Clave de acceso {{accessKey}}{{#if orderNumber}} (pedido #{{orderNumber}}){{/if}}.
{{#each messages}}- {{identifier}} {{message}}{{#if additionalInfo}}: {{additionalInfo}}{{/if}}
{{/each}}Revisar en el backoffice.`,
      },
    },
    'ticket.created': {
      email: {
        subject: 'Recibimos tu solicitud #{{number}}: {{subject}}',
        body: `<p>${hola}</p>
<p>Recibimos tu solicitud de soporte <strong>#{{number}}</strong>{{#if orderNumber}} sobre el pedido #{{orderNumber}}{{/if}}. Un agente te responderá por este medio.</p>
<p><a href="{{ticketUrl}}">Ver mi solicitud</a></p>
<p>Puedes responder o agregar detalles desde ese enlace.</p>`,
      },
    },
    'ticket.reply': {
      email: {
        subject: 'Respuesta a tu solicitud #{{number}}: {{subject}}',
        body: `<p>${hola}</p>
<p>Nuestro equipo de soporte respondió a tu solicitud <strong>#{{number}}</strong>:</p>
<blockquote style="white-space:pre-line;border-left:3px solid #ddd;margin:0;padding:0 12px">{{body}}</blockquote>
{{#if (eq status "resolved")}}<p>Dimos tu solicitud por resuelta. Si necesitas algo más, respóndenos desde el enlace y la reabrimos.</p>{{/if}}
<p><a href="{{ticketUrl}}">Responder</a></p>`,
      },
    },
    'ticket.csat': {
      email: {
        subject: '¿Cómo te atendimos? Solicitud #{{number}}',
        body: `<p>${hola}</p>
<p>Cerramos tu solicitud <strong>#{{number}}</strong> ({{subject}}). ¿Qué tan satisfecho quedaste con la atención?</p>
<p>{{#each scores}}<a href="{{url}}">{{score}}</a> {{/each}}</p>
<p>1 = nada satisfecho · 5 = muy satisfecho. <a href="{{csatUrl}}">Responder la encuesta</a></p>`,
      },
    },
    'ticket.sla_breached': {
      ntfy: {
        subject: 'Soporte: SLA vencido #{{number}} ({{priority}})',
        body: `{{subject}}
Venció: {{fecha slaDueAt}} · estado {{status}}{{#if assignedTo}}{{else}} · SIN ASIGNAR{{/if}}{{#if orderNumber}} · pedido #{{orderNumber}}{{/if}}.
Revisar en el backoffice.`,
      },
    },
    'cart.reminder.1h': {
      email: {
        subject: '¿Olvidaste algo? Tu carrito te espera',
        body: `<p>${hola}</p>
<p>Dejaste estas prendas en tu carrito de {{brand}}:</p>
{{> items}}
{{#if total}}<p><strong>Total: {{money total}}</strong></p>{{/if}}
<p><a href="{{cartUrl}}">Volver a mi carrito</a></p>`,
      },
      whatsapp: { body: '{{brand}}: dejaste {{itemCount}} prenda(s) en tu carrito. Termina tu compra aquí: {{cartUrl}}' },
    },
    'cart.reminder.24h': {
      email: {
        subject: 'Tus prendas siguen en el carrito',
        body: `<p>${hola}</p>
<p>Guardamos tu carrito, pero el stock se mueve rápido. Asegura tus tallas:</p>
{{> items}}
<p><a href="{{cartUrl}}">Terminar mi compra</a></p>`,
      },
      whatsapp: { body: '{{brand}}: tus prendas siguen en el carrito, pero el stock se mueve rápido. {{cartUrl}}' },
    },
    'cart.reminder.72h': {
      email: {
        subject: 'Última oportunidad para tu carrito',
        body: `<p>${hola}</p>
<p>Este es nuestro último recordatorio: tu carrito con {{itemCount}} prenda(s){{#if total}} por {{money total}}{{/if}} sigue disponible.</p>
{{> items}}
<p><a href="{{cartUrl}}">Ir a mi carrito</a></p>`,
      },
      whatsapp: { body: '{{brand}}: último recordatorio, tu carrito sigue disponible: {{cartUrl}}' },
      sms: { body: '{{brand}}: tu carrito sigue disponible: {{cartUrl}}' },
    },
  },
  'en-US': {
    'order.placed': {
      email: {
        subject: 'We received your order #{{orderNumber}}',
        body: `<p>${hi}</p>
<p>Thanks for shopping at {{brand}}. We received your order <strong>#{{orderNumber}}</strong>.</p>
{{> items}}
<p><strong>Total: {{money total}}</strong></p>
{{#if (eq paymentMethod "cod")}}<p>You pay on delivery: please have the exact amount or your card ready.</p>{{/if}}
{{#if (eq paymentMethod "transfer")}}<p>Remember to upload your bank transfer receipt so we can prepare your order.</p>{{/if}}
<p><a href="{{orderUrl}}">View my order</a></p>`,
      },
      webpush: { subject: 'Order #{{orderNumber}} received', body: 'Total {{money total}}. We will keep you posted.' },
      whatsapp: { body: '{{brand}}: we received your order #{{orderNumber}} for {{money total}}. Track it here: {{orderUrl}}' },
    },
    'order.paid': {
      email: {
        subject: 'Payment confirmed for order #{{orderNumber}}',
        body: `<p>${hi}</p>
<p>We confirmed your payment of <strong>{{money total}}</strong> for order <strong>#{{orderNumber}}</strong>. We are preparing it now.</p>
<p>Your electronic invoice will arrive in a separate email once the SRI authorizes it.</p>
<p><a href="{{orderUrl}}">View my order</a></p>`,
      },
      webpush: { subject: 'Payment confirmed', body: 'Order #{{orderNumber}}: we are preparing it.' },
    },
    'order.cancelled': {
      email: {
        subject: 'Your order #{{orderNumber}} was cancelled',
        body: `<p>${hi}</p>
<p>Your order <strong>#{{orderNumber}}</strong> was cancelled.{{#if reason}} Reason: {{reason}}.{{/if}}</p>
{{#if (eq paymentStatus "paid")}}<p>Since it was already paid, we started a refund of {{money total}} to the same payment method.</p>{{/if}}
<p>If you don't recognize this cancellation, reply to this email.</p>`,
      },
      webpush: { subject: 'Order #{{orderNumber}} cancelled', body: '{{#if reason}}{{reason}}{{else}}Tap to see the details.{{/if}}' },
    },
    'order.delivered': {
      email: {
        subject: 'Your order #{{orderNumber}} was delivered!',
        body: `<p>${hi}</p>
<p>We delivered your order <strong>#{{orderNumber}}</strong> on {{fecha deliveredAt}}. Enjoy it!</p>
<p>Something not right? You have {{returnWindowDays}} days to request an exchange or a return from <a href="{{orderUrl}}">your order</a>.</p>`,
      },
      webpush: { subject: 'Order delivered', body: 'Your order #{{orderNumber}} arrived. Enjoy!' },
    },
    'shipment.assigned': {
      webpush: { subject: 'Your order has a driver', body: 'Order #{{orderNumber}} is assigned for delivery.' },
    },
    'shipment.picked_up': {
      webpush: { subject: 'Your order left the warehouse', body: 'Order #{{orderNumber}}. Track it live.' },
    },
    'shipment.in_transit': {
      webpush: { subject: 'Your order is on its way', body: 'Order #{{orderNumber}}. Tap to track it.' },
      email: {
        subject: 'Your order #{{orderNumber}} is on its way',
        body: `<p>${hi}</p>
<p>Your order <strong>#{{orderNumber}}</strong> is on its way.</p>
<p><a href="{{trackingUrl}}">Track my shipment</a></p>`,
      },
    },
    'shipment.arriving': {
      webpush: { subject: 'Almost there!', body: 'The driver is close with your order #{{orderNumber}}.' },
      sms: { body: '{{brand}}: your order #{{orderNumber}} is arriving. Track it: {{trackingUrl}}' },
    },
    'shipment.delivered': {
      webpush: { subject: 'Shipment delivered', body: 'We delivered the shipment for your order #{{orderNumber}}.' },
    },
    'shipment.failed_attempt': {
      webpush: { subject: "We couldn't deliver your order", body: 'Order #{{orderNumber}}: we will try again. Tap for details.' },
      email: {
        subject: "We couldn't deliver your order #{{orderNumber}}",
        body: `<p>${hi}</p>
<p>We tried to deliver your order <strong>#{{orderNumber}}</strong> but it was not possible.{{#if description}} Details: {{description}}.{{/if}}</p>
<p>We will try again. Check the status from <a href="{{trackingUrl}}">tracking</a>.</p>`,
      },
      sms: { body: "{{brand}}: we couldn't deliver your order #{{orderNumber}}. Details: {{trackingUrl}}" },
    },
    'shipment.returned_to_origin': {
      email: {
        subject: 'Your order #{{orderNumber}} returned to our warehouse',
        body: `<p>${hi}</p>
<p>After several attempts, the shipment of your order <strong>#{{orderNumber}}</strong> returned to our warehouse. We will contact you to arrange a new delivery or a refund.</p>`,
      },
    },
    'invoice.authorized': {
      webpush: { subject: 'Your {{#if (eq docType "04")}}credit note{{else}}invoice{{/if}} is ready', body: '{{#if orderNumber}}Order #{{orderNumber}}: {{/if}}authorized by the SRI. We emailed it to you.' },
    },
    'ticket.created': {
      email: {
        subject: 'We received your request #{{number}}: {{subject}}',
        body: `<p>${hi}</p>
<p>We received your support request <strong>#{{number}}</strong>{{#if orderNumber}} about order #{{orderNumber}}{{/if}}. An agent will reply here.</p>
<p><a href="{{ticketUrl}}">View my request</a></p>
<p>You can reply or add details from that link.</p>`,
      },
    },
    'ticket.reply': {
      email: {
        subject: 'Reply to your request #{{number}}: {{subject}}',
        body: `<p>${hi}</p>
<p>Our support team replied to your request <strong>#{{number}}</strong>:</p>
<blockquote style="white-space:pre-line;border-left:3px solid #ddd;margin:0;padding:0 12px">{{body}}</blockquote>
{{#if (eq status "resolved")}}<p>We marked your request as resolved. If you need anything else, reply from the link and we will reopen it.</p>{{/if}}
<p><a href="{{ticketUrl}}">Reply</a></p>`,
      },
    },
    'ticket.csat': {
      email: {
        subject: 'How did we do? Request #{{number}}',
        body: `<p>${hi}</p>
<p>We closed your request <strong>#{{number}}</strong> ({{subject}}). How satisfied are you with our support?</p>
<p>{{#each scores}}<a href="{{url}}">{{score}}</a> {{/each}}</p>
<p>1 = not satisfied · 5 = very satisfied. <a href="{{csatUrl}}">Answer the survey</a></p>`,
      },
    },
    'cart.reminder.1h': {
      email: {
        subject: 'Forgot something? Your cart is waiting',
        body: `<p>${hi}</p>
<p>You left these items in your {{brand}} cart:</p>
{{> items}}
{{#if total}}<p><strong>Total: {{money total}}</strong></p>{{/if}}
<p><a href="{{cartUrl}}">Back to my cart</a></p>`,
      },
      whatsapp: { body: '{{brand}}: you left {{itemCount}} item(s) in your cart. Finish your purchase: {{cartUrl}}' },
    },
    'cart.reminder.24h': {
      email: {
        subject: 'Your items are still in your cart',
        body: `<p>${hi}</p>
<p>We saved your cart, but stock moves fast. Secure your sizes:</p>
{{> items}}
<p><a href="{{cartUrl}}">Complete my purchase</a></p>`,
      },
      whatsapp: { body: '{{brand}}: your items are still in your cart, but stock moves fast. {{cartUrl}}' },
    },
    'cart.reminder.72h': {
      email: {
        subject: 'Last chance for your cart',
        body: `<p>${hi}</p>
<p>This is our last reminder: your cart with {{itemCount}} item(s){{#if total}} for {{money total}}{{/if}} is still available.</p>
{{> items}}
<p><a href="{{cartUrl}}">Go to my cart</a></p>`,
      },
      whatsapp: { body: '{{brand}}: last reminder, your cart is still available: {{cartUrl}}' },
      sms: { body: '{{brand}}: your cart is still available: {{cartUrl}}' },
    },
  },
};
