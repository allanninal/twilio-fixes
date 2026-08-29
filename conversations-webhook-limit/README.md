# five conversation webhooks is the cap, and the sixth is rejected

The new integration worked all the way through staging and failed on its first real conversation with 50361, Too many conversation webhooks. Nothing about the new integration is wrong. It is the sixth thing to ask for a webhook on a conversation that allows five, and the five that got there first were added by code nobody has opened in a year.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/conversations-webhook-limit/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_conversation_webhook_limit_audit.py
node node/twilio-conversation-webhook-limit-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_conversation_webhook_limit_audit.py
node --test node/twilio-conversation-webhook-limit-audit.test.mjs
```
