# a published Studio Flow that no phone number points at

The Flow is built, published, and correct. Its Executions tab is empty, and it has been empty since the day it was created. Meanwhile the support line still plays whatever it played last year, because publishing a Flow tells Studio the definition is live &mdash; it does not tell a single phone number to send anything to it.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/studio-flow-not-wired-to-number/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_studio_wiring_audit.py
node node/twilio-studio-wiring-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_studio_wiring_audit.py
node --test node/twilio-studio-wiring-audit.test.mjs
```
