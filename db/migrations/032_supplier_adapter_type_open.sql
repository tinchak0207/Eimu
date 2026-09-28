-- 032: supplier.adapter_type CHECK 由列举改为非空（V-02，docs/architecture/planes-violations.md）。
-- 合法协议由程式码 registry 判定，不再在 DB 列举（见 docs/architecture/planes.md）。
ALTER TABLE supplier DROP CONSTRAINT IF EXISTS supplier_adapter_type_check;
ALTER TABLE supplier ADD CONSTRAINT supplier_adapter_type_check CHECK (adapter_type <> '');
