# TwiML that is not well-formed XML fails with 12100

The caller hears &ldquo;an application error has occurred&rdquo; and the line goes dead. Your handler ran, returned 200, and logged nothing unusual. Twilio logged 12100 Document parse failure, which means an XML parser looked at what you sent and refused it &mdash; and the usual reason is a single blank line that no code review will ever show you.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/twiml-document-parse-failure-12100/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_twiml_parse_audit.py
node node/twilio-twiml-parse-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_twiml_parse_audit.py
node --test node/twilio-twiml-parse-audit.test.mjs
```
