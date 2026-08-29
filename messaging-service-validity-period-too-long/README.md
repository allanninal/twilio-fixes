# a ten hour validity period delivers passcodes nobody wants

Nobody complains that the passcode failed. They complain that it arrived: at 4pm, for a login attempt made at six in the morning, after they gave up and requested three more. The Messaging Service is carrying the default validity_period of 36,000 seconds, so a message stuck behind a backlog is entitled to wait ten hours before Twilio gives up on it.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/messaging-service-validity-period-too-long/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_validity_ceiling_audit.py
node node/twilio-validity-ceiling-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_validity_ceiling_audit.py
node --test node/twilio-validity-ceiling-audit.test.mjs
```
