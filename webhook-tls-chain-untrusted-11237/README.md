# error 11237: your webhook sends a chain Twilio cannot verify

The certificate is valid. It was issued last week, it does not expire for a year, and every browser in the office shows a padlock. Twilio still refuses it with 11237 Certificate Invalid - Could not find path to certificate, because your server is sending one certificate where it should be sending two, and the browsers have been quietly covering for it since the day it was installed.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/webhook-tls-chain-untrusted-11237/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_webhook_chain_audit.py
node node/twilio-webhook-chain-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_webhook_chain_audit.py
node --test node/twilio-webhook-chain-audit.test.mjs
```
