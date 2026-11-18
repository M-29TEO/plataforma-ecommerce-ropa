# SRI simulado

Imita los web services **offline** de comprobantes electrónicos del SRI de Ecuador (ADR-10). El ambiente de
pruebas real (celcer) es gratuito, pero exige RUC y una firma `.p12` de una entidad acreditada, que tiene costo.
Node 24 puro, sin dependencias. El estado vive en memoria y se pierde al reiniciar el contenedor.

Usa las mismas rutas, operaciones SOAP y respuestas que `celcer.sri.gob.ec`. Por eso el adaptador del backend
(`SriSoapAdapter`) es el mismo para el simulador y para el SRI real: con `SRI_MODE=pruebas` solo cambia la URL.

| Ruta | Operación | Respuesta |
|---|---|---|
| `POST /comprobantes-electronicos-ws/RecepcionComprobantesOffline` | `validarComprobante` (`<xml>` en base64) | `RECIBIDA`, o `DEVUELTA` con mensajes |
| `POST /comprobantes-electronicos-ws/AutorizacionComprobantesOffline` | `autorizacionComprobante` (`<claveAccesoComprobante>`) | Sin autorizaciones mientras procesa (`authDelayMs`); luego `AUTORIZADO` con el comprobante en CDATA, o `NO AUTORIZADO` |
| `GET /admin/comprobantes` · `GET /admin/comprobantes/:clave` | Consola | Lo recibido, su estado y sus mensajes (con el XML en el detalle) |
| `GET/POST /admin/config` | Consola | `authDelayMs`, `latencyMs`, `failRate`, `consumerFinalMax` (cambian en caliente) |
| `POST /admin/reset` · `GET /health` | Consola | |

## Qué valida

**Recepción.** Los errores de esta etapa responden `DEVUELTA` y el comprobante se puede reenviar corregido con la misma clave:

| Código | Mensaje | Cuándo |
|---|---|---|
| 35 | ARCHIVO NO CUMPLE ESTRUCTURA XML | El XML está mal formado. Falta un campo obligatorio o tiene formato o longitud inválidos. La clave de acceso tiene mal el dígito verificador módulo 11, o no coincide con fecha, tipo de comprobante, RUC, ambiente, serie, secuencial o tipo de emisión. La cédula o el RUC del comprador son inválidos. La factura es a consumidor final y pasa de `consumerFinalMax` |
| 39 | FIRMA INVALIDA | El comprobante llegó sin `ds:Signature` |
| 43 | CLAVE ACCESO REGISTRADA | La clave ya se autorizó o se rechazó |
| 45 | SECUENCIAL REGISTRADO | El mismo RUC, serie y secuencial ya se usaron con otra clave |
| 70 | CLAVE DE ACCESO EN PROCESAMIENTO | Se reenvió mientras se procesa |

**Autorización.** Se decide al consultar, pasado `authDelayMs` desde la recepción:

| Código | Mensaje | Cuándo |
|---|---|---|
| 39 | FIRMA INVALIDA | No verifica la firma XAdES-BES. Se revisan el digest SHA-1 de cada `Reference`: comprobante (con enveloped-signature), `SignedProperties` y `KeyInfo`. También el `SignatureValue` RSA-SHA1 sobre el `SignedInfo` canónico y la vigencia del certificado. Se aceptan certificados autofirmados |
| 52 | ERROR EN DIFERENCIAS | Los montos no cuadran: cantidad × precio − descuento, IVA de cada línea, totales por impuesto, `importeTotal` o suma de `pagos`. La tolerancia es de 1 centavo |

La firma se verifica con un parser y un Canonical XML 1.0 propios ([xml.mjs](xml.mjs)), escritos aparte del
backend. [fixtures/](fixtures/) tiene facturas y una nota de crédito firmadas **por el backend**, que se regeneran con
`npm run -s sri:sample` (`-- --nota-credito` para la nota de crédito) desde `backend/`. Los tests comprueban que el
simulador las acepta y que rechaza cualquier alteración. La misma firma se validó también con `xmlsec1`
(implementación de referencia de XMLDSig).

**Notas de crédito (04).** Se acepta `notaCredito` versión 1.0.0 o 1.1.0 con las mismas reglas de recepción y
autorización, más las propias: `codDocModificado`, `numDocModificado` (`001-001-000000123`), `fechaEmisionDocSustento`
no posterior a la emisión, `motivo`, y `valorModificacion` = `totalSinImpuestos` + impuestos (52 si no cuadra). No se
admite a consumidor final (35). Si el simulador conoce la factura modificada, exige que esté AUTORIZADA y que las notas
de crédito vigentes sobre ella no superen su total (35).

Hay dos simplificaciones respecto del SRI real. Solo se aceptan la factura (01) y la nota de crédito (04), y una nota
de crédito sobre una factura que el simulador no conoce (se reinició) se acepta sin compararla. Además, no se consulta el
catastro: el RUC del emisor no se verifica contra un registro.

```bash
node --test                                    # tests
docker compose --profile sims up -d sri-simulado
curl localhost:8083/admin/comprobantes         # lo que recibió
curl -X POST localhost:8083/admin/config -H 'content-type: application/json' -d '{"failRate":1}'   # prueba el backoff
```

Variables opcionales: `AUTH_DELAY_MS` (3000), `LATENCY_MS` (0), `FAIL_RATE` (0), `CONSUMIDOR_FINAL_MAX` (50;
debe coincidir con `SRI_CONSUMIDOR_FINAL_MAX` del backend).
