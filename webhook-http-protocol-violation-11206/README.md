# error 11206: Twilio cannot parse your webhook's HTTP response

Your access log shows 200 for the request. Your framework's own instrumentation shows the handler completed in nine milliseconds and returned valid TwiML. And Twilio recorded 11206 HTTP protocol violation for that exact request, which is not a complaint about your status code or your XML &mdash; it is Twilio saying that the bytes coming back were not a well-formed HTTP response at all.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/webhook-http-protocol-violation-11206/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_webhook_protocol_audit.py
node node/twilio-webhook-protocol-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_webhook_protocol_audit.py
node --test node/twilio-webhook-protocol-audit.test.mjs
```
