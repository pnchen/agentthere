import { nanoid, customAlphabet } from 'nanoid';

export default nanoid;

export var nanoid_hex = customAlphabet('1234567890ABCDE', 21);

export var nanoid_tree_safe = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz', 21);
