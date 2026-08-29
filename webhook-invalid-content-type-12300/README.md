# a TwiML response with the wrong Content-Type fails with 12300

You paste the URL into a browser and the TwiML is right there, well-formed, exactly what you meant to send. Twilio disagrees: 12300 Invalid Content-Type, and the call ends. Nothing is wrong with the document. The rejection happened on a header, before Twilio looked at a single byte of the body.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/webhook-invalid-content-type-12300/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_content_type_audit.py
node node/twilio-content-type-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_content_type_audit.py
node --test node/twilio-content-type-audit.test.mjs
```
