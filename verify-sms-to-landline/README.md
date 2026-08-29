# Verify sends SMS to a landline: 60205, or just silence

A small, stubborn fraction of your signups never complete. They are not bots, they do not retry three times and give up, and support cannot reproduce any of it. The numbers look fine: right length, right country, valid E.164. They are landlines. An SMS to a landline either comes back 60205 or, if Lookup is off, disappears into a verification that stays pending until it expires &mdash; billed, delivered nowhere.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/verify-sms-to-landline/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_verify_landline_audit.py
node node/twilio-verify-landline-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_verify_landline_audit.py
node --test node/twilio-verify-landline-audit.test.mjs
```
