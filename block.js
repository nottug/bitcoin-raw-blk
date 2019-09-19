var hex = {
    decode: function(text) {
        return text.match(/.{2}/g).map(function(byte) {
            return parseInt(byte, 16);
        });
    },
    encode: function(bytes) {
        var result = [];
        for (var i = 0, hex; i < bytes.length; i++) {
            hex = bytes[i].toString(16);
            if (hex.length < 2) {
                hex = '0' + hex;
            }
            result.push(hex);
        }
        return result.join('');
    }
};

var littleEndian = {
    decode: function(bytes) {
        return bytes.reduce(function(previous, current, index) {
            return previous + current * Math.pow(256, index);
        }, 0);
    },
    encode: function(number, count) {
        var rawBytes = [];
        for (var i = 0; i < count; i++) {
            rawBytes[i] = number & 0xff;
            number = Math.floor(number / 256);
        }
        return rawBytes;
    }
};

var base58 = {
    _codes: '123456789ABCDEFGHJKLMNPQRSTUVWXYZ' +
        'abcdefghijkmnopqrstuvwxyz',
    _58: new BigInteger('58'),
    encode: function(bytes) {
        var number = new BigInteger(bytes);

        var output = [];

        while (number.compareTo(BigInteger.ZERO) > 0) {
            var result = number.divideAndRemainder(this._58);
            number = result[0];
            var remainder = result[1];
            output.push(this._codes.charAt(remainder));
        }

        // preserve leading zeros
        for (var i = 0; i < bytes.length; i++) {
            if (bytes[i] !== 0) {
                break;
            }
            output.push(this._codes[0]);
        }
        return output.reverse().join('');
    },
    decode: function(string) {
        var result = BigInteger.ZERO;
        var output = [], code, power;
        for (var i = 0; i < string.length; i++) {
            code = this._codes.indexOf(string.charAt(i));

            // preserve leading zeros
            if (result.equals(BigInteger.ZERO) && code === 0) {
                output.push(0);
            }
            power = this._58.pow(string.length - i - 1);
            code = new BigInteger('' + code);
            result = result.add(code.multiply(power));
        }
        output.push.apply(output, result.toByteArrayUnsigned());
        return output;
    }
};


function ArraySource(rawBytes, index) {
    this.rawBytes = rawBytes;
    this.index = index || 0;
}

ArraySource.prototype = {
    readByte: function() {
        if (!this.hasMoreBytes()) {
            throw new Error('Cannot read past the end of the array.');
        }
        return this.rawBytes[this.index++];
    },
    hasMoreBytes: function() {
        return this.index < this.rawBytes.length;
    },
    getPosition: function() {
        return this.index;
    }
};


function Stream(source) {
    this.source = source;
}

Stream.prototype = {
    readByte: function() {
        return this.source.readByte();
    },
    readBytes: function*(num) {
        var bytes = [];
        for (var i = 0; i < num; i++) {
            bytes.push(yield this.readByte());
        }
        return bytes;
    },
    readInt: function*(num) {
        var bytes = yield this.readBytes(num);
        return littleEndian.decode(bytes);
    },
    readVarInt: function*() {
        var num = yield this.readByte();
        if (num < 0xfd) {
            return num;
        } else if (num === 0xfd) {
            return this.readInt(2);
        } else if (num === 0xfe) {
            return this.readInt(4);
        } else {
            return this.readInt(8);
        }
    },
    readString: function*() {
        var length = yield this.readVarInt();
        return this.readBytes(length);
    },
    readHexBytes: function*(num) {
        var bytes = yield this.readBytes(num);
        return hex.encode(bytes.reverse());
    },
    hasMoreBytes: function() {
        return this.source.hasMoreBytes();
    },
    getPosition: function() {
        return this.source.getPosition();
    }
};


function Transaction(version, inputs, outputs, lockTime) {
    this.version = version || 1;
    this.inputs = inputs || [];
    this.outputs = outputs || [];
    this.lockTime = lockTime || 0;
}

Transaction.parse = function*(stream) {
    var transaction = new Transaction();
    transaction.version = yield stream.readInt(4);

    var txInNum = yield stream.readVarInt();
    for (var i = 0; i < txInNum; i++) {
        transaction.inputs.push({
            previousTxHash: yield stream.readHexBytes(32),
            previousTxOutIndex: yield stream.readInt(4),
            script: Script.readScript(yield stream.readString()),
            sequenceNo: yield stream.readHexBytes(4)
        });
    }

    var txOutNum = yield stream.readVarInt();
    for (var i = 0; i < txOutNum; i++) {
        transaction.outputs.push({
            value: yield stream.readInt(8),
            script: Script.readScript(yield stream.readString())
        });
    }

    transaction.lockTime = yield stream.readInt(4);

    return transaction;
};

function Block() {
}

Block.parse = function*(stream) {

    var findMagicNumber = function*(stream, octet) {
        while (octet !== 0xf9) {
            octet = yield stream.readByte();
        }
        octet = yield stream.readByte();
        if (octet !== 0xbe) {
            return findMagicNumber(stream, octet);
        }
        octet = yield stream.readByte();
        if (octet !== 0xb4) {
            return findMagicNumber(stream, octet);
        }
        octet = yield stream.readByte();
        if (octet !== 0xd9) {
            return findMagicNumber(stream, octet);
        }
    };

    yield findMagicNumber(stream);

    var block = new Block();

    block.length = yield stream.readInt(4);
    block.version = yield stream.readInt(4);
    block.previousBlockHash = hex.encode(yield stream.readBytes(32));
    block.merkleRoot = hex.encode(yield stream.readBytes(32));
    block.timeStamp = new Date((yield stream.readInt(4)) * 1000);
    block.target = yield stream.readInt(4);
    block.nonce = yield stream.readInt(4);
    block.transactions = [];

    var transactionCount = yield stream.readVarInt();
    for (var i = 0; i < transactionCount; i++) {
        block.transactions.push(yield Transaction.parse(stream));
    }

    return block;
};

function FileSource(file, index, chunkSize) {
    if (!file) {
        throw new Error('Argument file not defined.');
    }
    this.file = file;
    this.index = index || 0;
    this.chunkSize = chunkSize || (1024 * 1024);
    this.buffer = new ArraySource([]);
    this.reader = new FileReader();
}

FileSource.prototype = {
    readByte: function() {
        if (this.buffer.hasMoreBytes()) {
            return Promise.resolve(this.buffer.readByte());
        }
        if (!this.hasMoreBytes()) {
            var err = Error('Cannot read past the end of file.');
            return Promise.reject(err);
        }
        var _this = this;
        return this._readBytes().then(function(rawBytes) {
            _this.buffer = new ArraySource(rawBytes);
            return _this.readByte();
        });
    },
    hasMoreBytes: function() {
        return this.index < this.file.size;
    },
    getPosition: function() {
        return this.index - this.chunkSize + this.buffer.getPosition();
    },
    _readBytes: function() {
        return new Promise(function(resolve, reject) {
            this.reader.onload = function(e) {
                var bytes = new Uint8Array(e.target.result);
                resolve(bytes);
            };
            this.reader.onerror = reject;
            var index = this.index;
            var blob = this.file.slice(index, index + this.chunkSize);
            this.reader.readAsArrayBuffer(blob);
            this.index += this.chunkSize;
        }.bind(this));
    }
};

function getOutputScriptType(script) {
    if (script.length === 2 && script[1] === 'OP_CHECKSIG') {
        return 'pubkey';
    } else if (script.length === 5 &&
            script[0] === 'OP_DUP' &&
            script[1] === 'OP_HASH160' &&
            script[3] === 'OP_EQUALVERIFY' &&
            script[4] === 'OP_CHECKSIG') {
        return 'pubkeyhash';
    } else if (script[0] === 'OP_1' &&
            script[script.length - 1] === 'OP_CHECKMULTISIG') {
        return 'onemultisig';
    } else if (script[0] === 'OP_2' &&
            script[3] == 'OP_2' &&
            script[script.length - 1] === 'OP_CHECKMULTISIG') {
        return 'twomultisig';
    } else if (script.length === 3 &&
            script[0] === 'OP_HASH160' &&
            script[2] === 'OP_EQUAL') {
        return 'hash';
    } else if (script[0] === 'OP_RETURN') {
        return 'destroy';
    } else {
        return 'unknown';
    }
}

var findStrangeTransactions = function*(stream) {
    var block = yield Block.parse(stream);
    var strange = block.transactions.filter(function(transaction) {
        return transaction.outputs.some(function(output) {
            return getOutputScriptType(output.script) === 'unknown';
        });
    });
    var stats = block.transactions.reduce(function(stats, tx) {
        tx.outputs.forEach(function(output) {
            var type = getOutputScriptType(output.script);
            if (type in stats) {
                stats[type]++;
            } else {
                stats[type] = 1;
            }
        });
        return stats;
    }, {});
    var generation = block.transactions[0];
    // decode messages in input scripts
    var decoded = [];
    generation.inputs[0].script.forEach(function(instr) {
        if (instr.length > 20) {
            decoded.push(hex.decode(instr).map(function(char) {
                return String.fromCharCode(char);
            }).join(''));
        }
    });
    generation.inputs[0].decodedScript = decoded;
    return {
        block: block,
        generation: block.transactions[0],
        outputStatistics: stats,
        strangeTransactions: strange
    };
};
