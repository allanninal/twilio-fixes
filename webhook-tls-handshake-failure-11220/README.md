# error 11220: the TLS handshake with your webhook never completes

You paste the webhook URL into a browser and it loads, padlock and all. You run curl against it and get your TwiML back. And the Debugger keeps filling with 11220 SSL/TLS Handshake Error for that exact URL. Nothing is wrong with the certificate, because nothing ever got as far as looking at the certificate &mdash; the two ends could not agree on how to talk before either of them said who they were.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/webhook-tls-handshake-failure-11220/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_tls_handshake_audit.py
node node/twilio-tls-handshake-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_tls_handshake_audit.py
node --test node/twilio-tls-handshake-audit.test.mjs
```
