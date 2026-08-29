# extra numbers on a Sole Prop campaign never leave UNREGISTERED

Roughly a third of the messages get through. The rest come back 30034. Retrying works, sometimes, and which send succeeds changes every time, so the first theory is a flaky carrier and the second is a Twilio incident. It is neither. The Messaging Service is picking a sender per message from a pool of three, and on a Sole Proprietor brand only one of those three was ever registered.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/sole-prop-extra-numbers-unregistered/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_sole_prop_pool_audit.py
node node/twilio-sole-prop-pool-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_sole_prop_pool_audit.py
node --test node/twilio-sole-prop-pool-audit.test.mjs
```
