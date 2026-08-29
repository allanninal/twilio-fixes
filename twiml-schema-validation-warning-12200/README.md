# 12200: TwiML that parses, fails the schema, and is skipped

The &lt;Gather&gt; collects one digit instead of four and nobody can find an error, because there isn't one. numdigits was written in lower case, the schema rejected the attribute, and Twilio logged a 12200 at warning. Every dashboard, alert rule and sweep in the building filters on errors.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/twiml-schema-validation-warning-12200/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_twiml_schema_audit.py
node node/twilio-twiml-schema-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_twiml_schema_audit.py
node --test node/twilio-twiml-schema-audit.test.mjs
```
