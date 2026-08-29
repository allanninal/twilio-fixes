# error 30036: messages expire in the queue before they send

The messages were accepted. They were never sent. error_code 30036 means the message sat in the sender's queue until its ValidityPeriod ran out and Twilio dropped it &mdash; a deadline your own code set, enforced against a queue whose depth your own code did not know.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/validity-period-expired-30036/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_validity_period_audit.py
node node/twilio-validity-period-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_validity_period_audit.py
node --test node/twilio-validity-period-audit.test.mjs
```
