-- Other names a coordinator may type for a product in /order, such as
-- "black tee" for TS-BLK-M. The same alias may belong to several products:
-- "cap" for every cap is natural, and such an order line is then ambiguous
-- and must be clarified, never guessed.
create table product_aliases (
  workspace_id uuid not null,
  product_id uuid not null,
  alias text not null check (length(alias) between 1 and 64),
  normalized_alias text not null check (length(normalized_alias) between 1 and 64),
  primary key (product_id, normalized_alias),
  foreign key (workspace_id, product_id) references products (workspace_id, id) on delete cascade
);

create index product_aliases_lookup on product_aliases (workspace_id, normalized_alias);
