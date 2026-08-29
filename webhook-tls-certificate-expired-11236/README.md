# an expired webhook certificate fails every request with 11236

At 14:07 UTC everything was fine. At 14:08 every webhook on one hostname started failing with 11236 Certificate Invalid - Certificate Expired, and it has not stopped since. No deploy went out. No configuration changed. A renewal job stopped working ninety days ago and nobody noticed, because a certificate does not degrade &mdash; it works perfectly until the second it does not.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/webhook-tls-certificate-expired-11236/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_webhook_cert_audit.py
node node/twilio-webhook-cert-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_webhook_cert_audit.py
node --test node/twilio-webhook-cert-audit.test.mjs
```
