# error 30003 is a handset that is off, not a dead number

The send succeeded. The status walked queued, sent, then undelivered with error_code 30003, and the docs say the handset was unreachable &mdash; powered off, out of coverage, roaming. That is usually true and usually fixes itself. It is also exactly what a carrier block looks like from the outside, and the difference is arithmetic you have to do yourself.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/unreachable-destination-handset-30003/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_unreachable_handset_audit.py
node node/twilio-unreachable-handset-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_unreachable_handset_audit.py
node --test node/twilio-unreachable-handset-audit.test.mjs
```
