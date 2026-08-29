# no Usage Trigger, so overspend runs with nothing watching

The invoice is for eleven thousand dollars. Most of it is SMS to a country you do not sell in, sent over a Saturday night by the verification form on your signup page. Nobody was paged, because there was nothing to page: Usage Triggers are the only spend alarm Twilio runs on its own side, and an account is created with none of them.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/no-usage-trigger-configured/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_usage_trigger_audit.py
node node/twilio-usage-trigger-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_usage_trigger_audit.py
node --test node/twilio-usage-trigger-audit.test.mjs
```
