# a short code used outside its own country fails 21612

The short code has been delivering domestic traffic for two years at a throughput no long code can match. Then a customer in Canada is added to the same campaign and those messages come back 21612. Nothing changed about the short code, the Messaging Service or the campaign registration &mdash; the destination changed, and a short code is licensed for exactly one country.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/shortcode-cross-border-sender-mismatch/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_short_code_audit.py
node node/twilio-short-code-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_short_code_audit.py
node --test node/twilio-short-code-audit.test.mjs
```
