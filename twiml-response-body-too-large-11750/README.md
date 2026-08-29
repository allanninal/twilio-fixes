# a TwiML response over 64 kB drops the call with 11750

11750 TwiML response body too large reads like a capacity problem, so people go looking for the enormous document they must have generated. Usually there isn't one. The handler threw, the framework returned its debug page, and a stack trace with syntax highlighting and every local variable inlined sails past 64 kB without difficulty.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/twiml-response-body-too-large-11750/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_twiml_size_audit.py
node node/twilio-twiml-size-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_twiml_size_audit.py
node --test node/twilio-twiml-size-audit.test.mjs
```
