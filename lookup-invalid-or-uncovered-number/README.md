# an invalid or uncovered number: 21211 on send, 60600 on Lookup

The contact table has been filling up since before anyone thought about E.164. Some rows are (555) 010-9999, some are 07700 900123, some are fine. Twilio does not guess: a number that is not strictly E.164 comes back 21211 at send time, one send at a time, forever, and each of those failures is a customer who was supposed to hear from you.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/lookup-invalid-or-uncovered-number/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_lookup_validity_audit.py
node node/twilio-lookup-validity-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_lookup_validity_audit.py
node --test node/twilio-lookup-validity-audit.test.mjs
```
