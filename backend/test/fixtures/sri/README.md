# Certificado de firma SOLO para tests

Par RSA y certificado autofirmado generados con `bash scripts/generate-sri-cert.sh test/fixtures/sri`.
Se versionan a propósito: los tests unitarios de la firma XAdES y los de integración de Facturación
firman con ellos. No tienen valor fuera de los tests; nunca los uses en `secrets/`.
