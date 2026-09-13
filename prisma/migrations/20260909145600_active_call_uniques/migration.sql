-- One in-flight call per caller. Justified by createCall looking up non-terminal rows by callerId.
CREATE UNIQUE INDEX "one_active_call_per_caller"
ON "Call" ("callerId")
WHERE status IN ('INITIATED', 'RINGING', 'ACCEPTED', 'CONNECTING', 'CONNECTED');

-- One in-flight call per callee. Justified by createCall looking up non-terminal rows by calleeId.
CREATE UNIQUE INDEX "one_active_call_per_callee"
ON "Call" ("calleeId")
WHERE status IN ('INITIATED', 'RINGING', 'ACCEPTED', 'CONNECTING', 'CONNECTED');
