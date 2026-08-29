# error 30005 is permanent: the carrier has no such number

The same number fails every campaign. Every time, undelivered, error_code 30005, and every time the retry queue picks it up again because the handler that wrote it treated 30005 the way it treats 30003. It is not the same thing. The carrier is not saying the handset was busy; it is saying it has never heard of that number.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/unknown-destination-handset-30005/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_dead_number_audit.py
node node/twilio-dead-number-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_dead_number_audit.py
node --test node/twilio-dead-number-audit.test.mjs
```
