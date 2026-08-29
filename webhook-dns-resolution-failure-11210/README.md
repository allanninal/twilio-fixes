# a webhook hostname with no public DNS record fails with 11210

It worked on the laptop it was written on. It worked in staging. It reached production and every inbound call to that number now produces 11210 HTTP bad host name, because the hostname in the webhook resolves through an /etc/hosts line, an internal zone, or a tunnel that died when someone closed a terminal. Twilio resolves from the public internet and gets nothing back.

**Full guide with diagrams:** https://www.allanninal.dev/twilio/webhook-dns-resolution-failure-11210/

## Run it

```bash
export DRY_RUN="true"   # report only, write nothing
python python/twilio_webhook_dns_audit.py
node node/twilio-webhook-dns-audit.mjs
```

## Test it

```bash
pytest python/test_twilio_webhook_dns_audit.py
node --test node/twilio-webhook-dns-audit.test.mjs
```
