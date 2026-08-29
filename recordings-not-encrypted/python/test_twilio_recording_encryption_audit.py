from twilio_recording_encryption_audit import (
    is_encrypted, newest_first, parse_when, switch_point, verdict)

DETAILS = {"type": "rsa-aes-cbc-gcm"}


def rec(day, encrypted=False, sid="RE01"):
    row = {"sid": sid, "date_created": "Tue, %02d Apr 2024 09:12:00 +0000" % day}
    if encrypted:
        row["encryption_details"] = DETAILS
    return row


def test_an_account_with_no_recordings_has_nothing_in_the_clear():
    state, detail = verdict([])
    assert state == "none"
    assert "nothing stored" in detail


def test_every_recording_encrypted_is_the_clean_answer():
    state, _ = verdict([rec(1, True), rec(2, True)])
    assert state == "encrypted"


def test_nothing_encrypted_anywhere_means_it_was_never_switched_on():
    state, detail = verdict([rec(1), rec(2)])
    assert state == "plaintext"
    assert "never been on" in detail


def test_newest_encrypted_and_older_not_is_a_backlog_that_stays():
    state, detail = verdict([rec(1), rec(2), rec(3, True)])
    assert state == "backlog"
    assert "2 older one(s)" in detail
    assert "does not reach backwards" in detail


def test_newest_unencrypted_while_older_ones_are_encrypted_is_a_regression():
    state, detail = verdict([rec(1, True), rec(2, True), rec(3)])
    assert state == "regressed"
    assert "was on and is not any more" in detail


def test_the_two_mixed_cases_are_told_apart_only_by_the_ordering():
    rows = [rec(1), rec(2), rec(3, True)]
    assert verdict(rows)[0] == "backlog"
    assert verdict(list(reversed(rows)))[0] == "backlog"


def test_the_switch_point_is_the_newest_recording_still_in_the_clear():
    assert switch_point([rec(1), rec(5), rec(9, True)]) == \
        "Tue, 05 Apr 2024 09:12:00 +0000"
    assert switch_point([rec(1, True)]) is None


def test_presence_is_the_test_rather_than_a_value():
    assert is_encrypted({"encryption_details": DETAILS}) is True
    assert is_encrypted({"encryption_details": None}) is False
    assert is_encrypted({}) is False


def test_an_unparseable_date_sorts_last_instead_of_raising():
    rows = newest_first([{"sid": "RE99", "date_created": "whenever"}, rec(4)])
    assert [r["sid"] for r in rows] == ["RE01", "RE99"]


def test_parse_when_reads_rfc_2822():
    assert parse_when("Tue, 18 Apr 2023 09:12:00 +0000") is not None
    assert parse_when("") is None
    assert parse_when("not a date") is None
