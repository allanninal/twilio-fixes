# a conversation webhook with no URL fails every event: 50369

The Debugger fills up with 50369, Conversation webhook URL not provided. The webhook resource exists. It is attached to the conversation, it has the right target, and it has been there since the integration was built. What it does not have is a URL, so every message added to that conversation raises an error and reaches nothing.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/conversations-webhook-url-missing/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_conversation_webhook_audit.py
node node/twilio-conversation-webhook-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_conversation_webhook_audit.py
node --test node/twilio-conversation-webhook-audit.test.mjs
```
