# a phone number still points at Twilio's demo TwiML

The number rings. It answers. It plays a cheerful message about Twilio and hangs up. Nothing appears in the Debugger, nothing appears in your logs, and every call in the console is marked completed &mdash; because the webhook Twilio fetched answered perfectly. It just was not yours.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/phone-number-still-on-demo-twiml/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_demo_twiml_audit.py
node node/twilio-demo-twiml-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_demo_twiml_audit.py
node --test node/twilio-demo-twiml-audit.test.mjs
```
