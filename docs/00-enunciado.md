# Enunciado original del trabajo

Actúa como un Arquitecto de Software Senior especializado en e-commerce, logística de última milla y sistemas multi-rol en la nube. Necesito que diseñes la arquitectura completa, escalable y segura de una plataforma de venta de ropa en línea con entregas locales y nacionales, similar a una app de pedidos de comida pero adaptada a moda.

> **Restricción adicional del proyecto:** por ser un trabajo universitario, se usan **exclusivamente herramientas open source y sin costo**. Los servicios comerciales (pasarelas de pago, SRI, couriers, WhatsApp, SMS) se implementan mediante simuladores detrás de puertos (arquitectura hexagonal).

## CONTEXTO DEL NEGOCIO

País base: Ecuador.
Modelo: E-commerce B2C con catálogo variable (ropa), carrito, checkout, pagos en línea y contra entrega, gestión de zonas de cobertura, asignación de motorizados propios y envíos por couriers externos (Servientrega y otros). Pagos con Banco Pichincha, DeUna, tarjetas (Datafast/Payphone/Medianet), transferencia, QR y contra entrega.
Facturación electrónica conforme al SRI Ecuador.

## ROLES DEL SISTEMA

1. Cliente (web + móvil + PWA)
2. Administrador (CRUD total: productos, precios, stock, usuarios, zonas)
3. Gerente (dashboards, reportes, KPIs, márgenes, conversión)
4. Vendedor / Atención al cliente
5. Bodega / Inventario
6. Motorizado (app móvil)
7. Soporte / Tickets
8. Courier externo (integración API)

## MÓDULOS FUNCIONALES REQUERIDOS

### A) Catálogo y Producto
- Variantes: talla, color, material, temporada, género, marca.
- Stock por bodega/sucursal, alertas de stock bajo, reposición.
- Guía de tallas, fotos 360, video, probador virtual (AR).
- Búsqueda con filtros avanzados, recomendaciones por historial.
- Reseñas con fotos, preguntas y respuestas.
- Lista de deseos/favoritos.

### B) Carrito y Checkout
- Carrito persistente, checkout como invitado, multi-dirección.
- Cupones, promociones, 2x1, envío gratis por monto.
- Gift cards, carrito abandonado (recordatorios email/WhatsApp).
- Entrega programada por franjas horarias.

### C) Pedidos y Pagos
- Estados del pedido: creado, pagado, en preparación, despachado, en camino, entregado, cancelado, devuelto.
- Pasarelas: Pichincha, DeUna, tarjetas (tokenizadas, PCI-DSS), transferencia, QR, contra entrega.
- Facturación electrónica SRI, notas de crédito, conciliación.
- Devoluciones, cambios, reembolsos.

### D) Logística y Entregas
- Motor de reglas: si hay motorizado en zona → asignar; si no → cotizar Servientrega u otros couriers.
- Cálculo de envío por distancia, peso, volumen, zona.
- Asignación automática por cercanía, carga y disponibilidad.
- App motorizado: navegación, estados, prueba de entrega (foto, firma, OTP).
- Tracking en tiempo real para el cliente.
- Calificación de motorizado/cliente, comisiones y liquidaciones.
- Generación de guías y etiquetas para couriers.

### E) Paneles y Reportes
- Dashboard gerente: ventas por día/semana/mes, ciudad, barrio, producto, categoría, talla, color, método de pago, courier, motorizado, ticket promedio, margen, conversión, carritos abandonados, tiempos de entrega, cumplimiento.
- Exportación a Excel/PDF.
- Auditoría de cambios, roles y permisos granulares, 2FA admin.

### F) Marketing y Crecimiento
- Programa de puntos, niveles, referidos, fidelización.
- SEO, Google Shopping, Facebook Pixel, email marketing.
- Catálogo por WhatsApp, chat en vivo, chatbot.
- Multi-idioma, multi-moneda, PWA.

### G) Operaciones
- Gestión de proveedores y compras, códigos de barras/QR.
- Modo mantenimiento, sistema de tickets, notificaciones (WhatsApp, email, SMS, push).

## REQUISITOS NO FUNCIONALES

- Seguridad: OWASP Top 10, PCI-DSS, cifrado en tránsito y reposo, JWT/OAuth2, rate limiting, WAF.
- Escalabilidad: horizontal, auto-scaling, microservicios o monolito modular evolutivo.
- Disponibilidad: 99.9%, tolerancia a fallos, retries, circuit breaker.
- Rendimiento: <2s carga, CDN, cache Redis, colas asíncronas.
- Observabilidad: logs centralizados, métricas, tracing, alertas.
- Multi-tenant opcional para futuras marcas.
- Cumplimiento legal Ecuador: SRI, Ley de Protección de Datos.

## ENTREGABLES

1. Arquitectura de alto nivel (diagrama C4: contexto, contenedores, componentes).
2. Stack tecnológico recomendado justificado (frontend, backend, DB, cache, colas, storage, hosting, CI/CD, monitoreo).
3. Modelo entidad-relación completo con todas las tablas, campos, relaciones e índices.
4. Diseño de APIs REST/GraphQL (endpoints principales por módulo, versionado, autenticación).
5. Diagrama de flujos clave: checkout, pago, asignación motorizado, cotización courier, tracking, devolución.
6. Arquitectura de integraciones: pagos, SRI, couriers, mapas, WhatsApp, email, SMS, push.
7. Estrategia de seguridad y cumplimiento.
8. Estrategia de despliegue (entornos dev/staging/prod, CI/CD, IaC, backups, DRP).
9. Roadmap de implementación por fases (MVP → V2 → V3) con estimación de tiempos y equipo.
10. Riesgos técnicos y mitigaciones.
11. Recomendaciones de costos (en este proyecto: infraestructura self-hosted sin costo).

## RESTRICCIONES

- Prioriza MVP funcional en 8-12 semanas con equipo pequeño (2-3 devs full-stack, 1 UX, 1 QA).
- Usa tecnologías maduras, con comunidad activa y buen soporte en LATAM.
- La arquitectura debe permitir crecer sin reescribir.
- Documenta en español, con diagramas en Mermaid o PlantUML.

## FORMATO DE RESPUESTA

Secciones numeradas, diagramas en Mermaid, tablas comparativas donde aplique, y código de ejemplo en los puntos críticos (modelo de datos en SQL, contratos de API en OpenAPI, docker-compose base).

## Estado de los entregables

| # | Entregable | Estado | Archivo |
|---|---|---|---|
| 1 | Arquitectura C4 | ✅ | docs/01-arquitectura-c4.md |
| 2 | Stack tecnológico (open source) | ✅ | docs/02-stack-open-source.md |
| 3 | Modelo de datos | ✅ | docs/03-modelo-datos.sql |
| 4 | APIs (OpenAPI) | ⏳ | — |
| 5 | Flujos clave | ⏳ | — |
| 6-11 | Resto | ⏳ | — |
