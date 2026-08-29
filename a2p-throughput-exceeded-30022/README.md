# 30022 when sends outrun the throughput the carrier assigned

It only happens during the morning send. The same message, retried at lunchtime, delivers. So the bug report reads &ldquo;intermittent SMS failures&rdquo; and gets triaged as a Twilio problem, when 30022 is Twilio telling you precisely what it is: your combined send rate across the campaign went past a number the carrier assigned you, and that number is published on the campaign resource.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/a2p-throughput-exceeded-30022/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_a2p_throughput_report.py
node node/twilio-a2p-throughput-report.mjs
```

## Test it

```bash
pytest python/test_twilio_a2p_throughput_report.py
node --test node/twilio-a2p-throughput-report.test.mjs
```
