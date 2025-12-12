// src/zip.js

// CRC32 表预计算
const crcTable = new Int32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
}

function crc32(data, prev = 0) {
    let c = prev ^ -1;
    for (let i = 0; i < data.length; i++) c = (c >>> 8) ^ crcTable[(c ^ data[i]) & 0xFF];
    return c ^ -1;
}

/**
 * 创建一个流式 ZIP 响应流
 * @param {Array} files - 文件列表 [{ zipPath, size, file_id, ... }]
 * @param {Object} storage - 存储实例
 * @param {string} userId - 用户 ID
 * @returns {ReadableStream}
 */
export function createZipStream(files, storage, userId) {
    const encoder = new TextEncoder();
    let fileIndex = 0;
    let centralDirectory = [];
    let offset = 0;

    return new ReadableStream({
        async start(controller) {
            // 无需初始化
        },
        async pull(controller) {
            if (fileIndex >= files.length) {
                // 所有文件处理完毕，写入 Central Directory
                const cdBuffer = new Uint8Array(centralDirectory.reduce((acc, val) => acc + val.length, 0));
                let cdOffset = 0;
                for (const chunk of centralDirectory) {
                    cdBuffer.set(chunk, cdOffset);
                    cdOffset += chunk.length;
                }
                controller.enqueue(cdBuffer);

                // 写入 End of Central Directory Record
                const eocd = new Uint8Array(22);
                const view = new DataView(eocd.buffer);
                view.setUint32(0, 0x06054b50, true); // Signature
                view.setUint16(4, 0, true); // Disk number
                view.setUint16(6, 0, true); // Disk number with start of CD
                view.setUint16(8, files.length, true); // Number of records on this disk
                view.setUint16(10, files.length, true); // Total number of records
                view.setUint32(12, cdBuffer.length, true); // Size of CD
                view.setUint32(16, offset, true); // Offset of start of CD
                view.setUint16(20, 0, true); // Comment length

                controller.enqueue(eocd);
                controller.close();
                return;
            }

            const file = files[fileIndex++];
            const fileNameBytes = encoder.encode(file.zipPath);
            
            // 1. Local File Header
            // 使用 Data Descriptor (Bit 3)，因为我们流式传输时还没算出 CRC32
            const lfh = new Uint8Array(30 + fileNameBytes.length);
            const view = new DataView(lfh.buffer);
            
            view.setUint32(0, 0x04034b50, true); // Signature
            view.setUint16(4, 0x000A, true); // Version needed
            view.setUint16(6, 0x0800, true); // Flags (Bit 3 set for Data Descriptor)
            view.setUint16(8, 0, true); // Compression (0 = Store)
            // Time/Date 设为 0 或转换 file.date
            view.setUint32(10, 0, true); 
            view.setUint32(14, 0, true); // CRC32 (later)
            view.setUint32(18, 0, true); // Compressed Size (later)
            view.setUint32(22, 0, true); // Uncompressed Size (later)
            view.setUint16(26, fileNameBytes.length, true); // Filename length
            view.setUint16(28, 0, true); // Extra field length
            lfh.set(fileNameBytes, 30);

            controller.enqueue(lfh);
            
            // 记录 CD 信息 (部分)
            const cdEntryStart = offset;
            offset += lfh.length;

            // 2. Stream File Content & Calculate CRC
            let fileCrc = 0;
            let fileSize = 0;

            try {
                // 获取文件流
                const downloadResult = await storage.download(file.file_id || file.message_id, userId);
                const reader = downloadResult.stream.getReader();

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    fileCrc = crc32(value, fileCrc);
                    fileSize += value.length;
                    offset += value.length;
                    controller.enqueue(value);
                }
            } catch (e) {
                console.error(`Failed to zip file ${file.zipPath}:`, e);
                // 即使出错也继续，只是这个文件内容可能为空或截断
            }

            // 3. Data Descriptor
            // Signature (4) + CRC32 (4) + Compressed (4) + Uncompressed (4)
            const dd = new Uint8Array(16);
            const ddView = new DataView(dd.buffer);
            ddView.setUint32(0, 0x08074b50, true);
            ddView.setInt32(4, fileCrc, true); // CRC32
            ddView.setUint32(8, fileSize, true); // Compressed
            ddView.setUint32(12, fileSize, true); // Uncompressed
            controller.enqueue(dd);
            offset += 16;

            // 4. 构建 Central Directory Record (存入内存，最后发送)
            const cd = new Uint8Array(46 + fileNameBytes.length);
            const cdView = new DataView(cd.buffer);
            cdView.setUint32(0, 0x02014b50, true); // Signature
            cdView.setUint16(4, 0x000A, true); // Version made by
            cdView.setUint16(6, 0x000A, true); // Version needed
            cdView.setUint16(8, 0x0800, true); // Flags (Bit 3)
            cdView.setUint16(10, 0, true); // Compression (Store)
            cdView.setUint32(12, 0, true); // Time
            cdView.setInt32(16, fileCrc, true); // CRC32
            cdView.setUint32(20, fileSize, true); // Compressed
            cdView.setUint32(24, fileSize, true); // Uncompressed
            cdView.setUint16(28, fileNameBytes.length, true); // Filename len
            cdView.setUint16(30, 0, true); // Extra len
            cdView.setUint16(32, 0, true); // Comment len
            cdView.setUint16(34, 0, true); // Disk start
            cdView.setUint16(36, 0, true); // Internal attr
            cdView.setUint32(38, 0, true); // External attr
            cdView.setUint32(42, cdEntryStart, true); // Offset of LFH
            cd.set(fileNameBytes, 46);
            
            centralDirectory.push(cd);
        }
    });
}
