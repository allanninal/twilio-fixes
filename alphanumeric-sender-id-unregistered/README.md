# an alphanumeric sender ID is unregistered where you send

The launch in India went out on the same sender ID that has worked in Europe for two years. Every message came back 30041. The create calls all returned 201, the sender is configured on the Messaging Service, and the console shows nothing wrong &mdash; because the rejection happened at a carrier in Mumbai, long after Twilio accepted the request.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/alphanumeric-sender-id-unregistered/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_alpha_sender_audit.py
node node/twilio-alpha-sender-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_alpha_sender_audit.py
node --test node/twilio-alpha-sender-audit.test.mjs
```
