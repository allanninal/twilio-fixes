# a suspended subaccount, so one tenant's traffic 20005s

One customer opens a ticket saying none of their messages have gone out since Thursday. Every other customer is fine. The parent account dashboard is green, the balance is healthy, the Debugger is quiet, and the only thing wrong is a three-letter field on a resource nobody on the team has read since the tenant was provisioned: that subaccount's status is suspended, and Twilio told nobody.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/subaccount-suspended-silently/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_subaccount_status_audit.py
node node/twilio-subaccount-status-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_subaccount_status_audit.py
node --test node/twilio-subaccount-status-audit.test.mjs
```
