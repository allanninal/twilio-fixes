# a voice-only From number fails every SMS with error 21606

The number works. People call it, the IVR answers, it has been on the account for two years. Then a new notification job starts sending from it and every single message is rejected with 21606: 'From' number is not a valid message-capable Twilio number for this account. Both halves of that sentence are load-bearing, and only one of them is about SMS.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/from-number-not-sms-capable/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_from_number_capability_audit.py
node node/twilio-from-number-capability-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_from_number_capability_audit.py
node --test node/twilio-from-number-capability-audit.test.mjs
```
