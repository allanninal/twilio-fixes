# Programmable Chat is still in use past its end of life

The Chat SDK still works. Channels list, messages send, the integration tests are green, and the changelog entry announcing the end of life went to a billing address that forwards to a team alias nobody reads. Nothing failed on 1 June 2026 and nothing will fail on any particular morning after it. The account simply has three IS services on it that Twilio is no longer developing, and an iOS build from last year still talking to them.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/eol-programmable-chat-in-use/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_chat_eol_audit.py
node node/twilio-chat-eol-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_chat_eol_audit.py
node --test node/twilio-chat-eol-audit.test.mjs
```
