# error 14107: an auto-reply loop trips the SMS rate limit

Two of your own numbers found each other. One auto-replies to everything it receives, the other does too, and for about half a minute they had the fastest conversation in the account's history. Then 14107 stopped it: SMS send rate limit exceeded. The rate limit is not the problem. It is the seatbelt, and it did its job.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/sms-reply-loop-rate-limit-14107/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_reply_loop_audit.py
node node/twilio-reply-loop-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_reply_loop_audit.py
node --test node/twilio-reply-loop-audit.test.mjs
```
