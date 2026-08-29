# one smart quote triples your segment count and your bill

Nothing failed. Every message says delivered, every customer got it, and the only thing that changed is the invoice: the SMS line is three times what it was on the same send volume. Somewhere in a template, an edit made in a rich text box replaced a straight apostrophe with a curly one. Every message that template renders now costs three segments instead of one, and there is no error code anywhere in the account to say so.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/ucs2-segment-inflation/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_segment_audit.py
node node/twilio-segment-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_segment_audit.py
node --test node/twilio-segment-audit.test.mjs
```
