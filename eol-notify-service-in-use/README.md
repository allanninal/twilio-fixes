# Notify services still on the account after Notify's EOL

Push notifications stopped some time last winter. Nobody can put a date on it, because nothing recorded one. The Notify service is still in the API, the bindings are still listed, your code still gets a response it can parse, and the handset gets nothing. Twilio Notify reached end of life on 31 December 2025. The resource outlived the product by a comfortable margin, which is the only reason this is still in the codebase.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/eol-notify-service-in-use/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_notify_eol_audit.py
node node/twilio-notify-eol-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_notify_eol_audit.py
node --test node/twilio-notify-eol-audit.test.mjs
```
