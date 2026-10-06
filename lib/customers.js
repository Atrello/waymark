'use strict';
/**
 * Customers. Sites (places) and journey legs (log) link to a customer by id; the customer's name is
 * mirrored into places.default_business and log.business so a rename/merge updates everything at once.
 *
 * Reassigning a site only changes the default for future journeys; past journey legs keep the
 * customer they were logged against (use Merge to move history).
 */
const db = require('./db');
const { UserError, str } = require('./util');

/** All customers with journey totals. userId: count only that user's legs (for the User role); omit for everyone's. */
function list(userId) {
  const mine = userId ? ' AND l.user_id = :uid' : '';
  return db.open().prepare(`
    SELECT c.id, c.name, c.notes,
      (SELECT COUNT(*) FROM places p WHERE p.customer_id = c.id) AS sites,
      (SELECT COUNT(*) FROM log l WHERE l.customer_id = c.id AND l.data_type = 'Live'${mine}) AS legs,
      (SELECT COALESCE(SUM(miles), 0) FROM log l WHERE l.customer_id = c.id AND l.data_type = 'Live'${mine}) AS miles,
      (SELECT COALESCE(SUM(claim), 0) FROM log l WHERE l.customer_id = c.id AND l.data_type = 'Live'${mine}) AS claim,
      (SELECT MAX(date) FROM log l WHERE l.customer_id = c.id${mine}) AS lastVisit
    FROM customers c ORDER BY c.name COLLATE NOCASE`).all(userId ? { uid: Number(userId) } : {})
    .map((r) => ({ ...r, miles: Math.round(r.miles * 10) / 10, claim: Math.round(r.claim * 100) / 100 }));
}

function get(id) {
  const c = db.open().prepare('SELECT id, name FROM customers WHERE id = ?').get(Number(id));
  if (!c) throw new UserError('That customer no longer exists. Reload the page.');
  return c;
}

/** Resolve an optional customer id from user input -> {id, name} or null. */
function resolve(id) {
  if (id === '' || id == null) return null;
  return get(id);
}

function result(message) {
  return { message, customers: list(), places: db.listPlaces() };
}

function validate(input) {
  input = input || {};
  return {
    name: str(input.name, 100, 'Customer name'),
    notes: str(input.notes, 500, 'Notes', true),
  };
}

function checkUnique(d, name, exceptId) {
  const clash = d.prepare('SELECT name FROM customers WHERE name = ? COLLATE NOCASE AND id <> ?').get(name, exceptId || 0);
  if (clash) throw new UserError(`A customer called "${clash.name}" already exists. Use Merge to combine them.`);
}

/** Set exactly this list of sites for the customer (others it had become unassigned). */
function assignSites(d, customer, placeIds) {
  if (!Array.isArray(placeIds)) return;
  const ids = [...new Set(placeIds.map(Number).filter(Number.isInteger))];
  d.prepare("UPDATE places SET customer_id = NULL, default_business = '' WHERE customer_id = ?").run(customer.id);
  const set = d.prepare('UPDATE places SET customer_id = ?, default_business = ? WHERE id = ?');
  for (const pid of ids) set.run(customer.id, customer.name, pid);
}

function create(input) {
  const c = validate(input);
  return db.tx((d) => {
    checkUnique(d, c.name);
    const r = d.prepare('INSERT INTO customers(name, notes) VALUES (?, ?)').run(c.name, c.notes);
    assignSites(d, { id: Number(r.lastInsertRowid), name: c.name }, input && input.placeIds);
    return result(`Added customer "${c.name}".`);
  });
}

function update(id, input) {
  const c = validate(input);
  return db.tx((d) => {
    const old = get(id);
    checkUnique(d, c.name, old.id);
    d.prepare('UPDATE customers SET name = ?, notes = ? WHERE id = ?').run(c.name, c.notes, old.id);
    let message = `Saved "${c.name}".`;
    if (old.name !== c.name) {
      d.prepare('UPDATE places SET default_business = ? WHERE customer_id = ?').run(c.name, old.id);
      const n = d.prepare('UPDATE log SET business = ? WHERE customer_id = ?').run(c.name, old.id).changes;
      message = `Renamed "${old.name}" to "${c.name}"${n ? ` (updated ${n} journey leg${n === 1 ? '' : 's'})` : ''}.`;
    }
    assignSites(d, { id: old.id, name: c.name }, input && input.placeIds);
    return result(message);
  });
}

/** Move all sites and journey legs from one customer to another, then delete the first. */
function merge(id, intoId) {
  return db.tx((d) => {
    const from = get(id), into = get(intoId);
    if (from.id === into.id) throw new UserError('Pick a different customer to merge into.');
    const sites = d.prepare('UPDATE places SET customer_id = ?, default_business = ? WHERE customer_id = ?').run(into.id, into.name, from.id).changes;
    const legs = d.prepare('UPDATE log SET customer_id = ?, business = ? WHERE customer_id = ?').run(into.id, into.name, from.id).changes;
    d.prepare('DELETE FROM customers WHERE id = ?').run(from.id);
    return result(`Merged "${from.name}" into "${into.name}" (${sites} site${sites === 1 ? '' : 's'}, ${legs} journey leg${legs === 1 ? '' : 's'}).`);
  });
}

function remove(id) {
  return db.tx((d) => {
    const c = get(id);
    const legs = d.prepare('SELECT COUNT(*) n FROM log WHERE customer_id = ?').get(c.id).n;
    if (legs) throw new UserError(`"${c.name}" has ${legs} journey leg(s), so it can't be deleted. Use Merge to move them to another customer.`);
    d.prepare("UPDATE places SET customer_id = NULL, default_business = '' WHERE customer_id = ?").run(c.id);
    d.prepare('DELETE FROM customers WHERE id = ?').run(c.id);
    return result(`Deleted customer "${c.name}". Its sites are now unassigned.`);
  });
}

module.exports = { list, get, resolve, create, update, merge, remove };
