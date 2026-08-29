# nothing subscribes to error logs, so failures age out

The postmortem needs the hour before the incident, and the incident was seven weeks ago. That hour does not exist. It is not in the warehouse, not in the logging stack, not in a bucket somewhere: the Debugger holds its alerts for thirty days and pushes them nowhere unless something asks it to, and on this account nothing ever asked.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/no-error-log-subscription/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_error_log_subscription_audit.py
node node/twilio-error-log-subscription-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_error_log_subscription_audit.py
node --test node/twilio-error-log-subscription-audit.test.mjs
```
