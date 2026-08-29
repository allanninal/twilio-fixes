# recycled numbers send OTPs to whoever owns them now

Every message says delivered. The password reset code, the appointment reminder, the balance alert &mdash; all of them accepted by the carrier, all of them handed to a handset. Just not the handset you think. The number was disconnected eleven weeks ago and reissued to somebody who has never heard of you, and your contact table has not noticed.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/deactivated-number-recycling/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_deactivations_audit.py
node node/twilio-deactivations-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_deactivations_audit.py
node --test node/twilio-deactivations-audit.test.mjs
```
