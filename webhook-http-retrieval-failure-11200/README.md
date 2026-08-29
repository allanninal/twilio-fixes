# 11200 on the TwiML fetch: the call fails, not just a receipt

The Debugger shows a wall of 11200 and everyone agrees it is the same known issue with the delivery receipts. It is not. Some of these are on voice_url, and an 11200 there is not a receipt that went missing &mdash; it is a caller who heard an application error has occurred and then a dial tone.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/webhook-http-retrieval-failure-11200/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_twiml_retrieval_audit.py
node node/twilio-twiml-retrieval-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_twiml_retrieval_audit.py
node --test node/twilio-twiml-retrieval-audit.test.mjs
```
